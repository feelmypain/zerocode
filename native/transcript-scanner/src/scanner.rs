use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

use memchr::{memchr, memmem};
use serde::Deserialize;

use crate::json_project::{ByteSource, ProjectorScratch, SelectNode, SliceSource, project_json};

pub const GUARD_LENGTH: usize = 64;
const DEFAULT_STREAMING_THRESHOLD_BYTES: usize = 8 * 1024 * 1024;
const READ_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFileRequest {
    pub path: String,
    #[serde(default)]
    pub resume_offset: u64,
    #[serde(default)]
    pub guard_length: usize,
    #[serde(default)]
    pub guard_hash: u32,
}

pub struct ScanFileOutput {
    pub ok: bool,
    pub resumed: bool,
    pub resume_offset: u64,
    pub guard_length: usize,
    pub guard_hash: u32,
    /// Pre-serialized compact projected JSON values for `\n`-terminated lines.
    pub lines: Vec<Vec<u8>>,
    /// Pre-serialized compact projected JSON value for an unterminated trailing line, if any.
    pub tail: Option<Vec<u8>>,
}

impl ScanFileOutput {
    fn failed() -> Self {
        Self {
            ok: false,
            resumed: false,
            resume_offset: 0,
            guard_length: 0,
            guard_hash: 0,
            lines: Vec::new(),
            tail: None,
        }
    }
}

#[inline]
pub fn fnv1a(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for &byte in bytes {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

fn guard_matches(file: &mut File, req: &ScanFileRequest) -> bool {
    if req.resume_offset == 0 || req.guard_length == 0 || req.guard_length > GUARD_LENGTH {
        return false;
    }
    let Some(guard_start) = req.resume_offset.checked_sub(req.guard_length as u64) else {
        return false;
    };
    let mut window = [0u8; GUARD_LENGTH];
    let slice = &mut window[..req.guard_length];
    if file.seek(SeekFrom::Start(guard_start)).is_err() {
        return false;
    }
    if file.read_exact(slice).is_err() {
        return false;
    }
    fnv1a(slice) == req.guard_hash
}

fn compute_guard(file: &mut File, resume_offset: u64) -> io::Result<(usize, u32)> {
    let guard_length = (resume_offset as usize).min(GUARD_LENGTH);
    if guard_length == 0 {
        return Ok((0, 0));
    }
    let mut window = [0u8; GUARD_LENGTH];
    let slice = &mut window[..guard_length];
    file.seek(SeekFrom::Start(resume_offset - guard_length as u64))?;
    file.read_exact(slice)?;
    Ok((guard_length, fnv1a(slice)))
}

struct MarkerGate<'a> {
    finders: Vec<memmem::Finder<'a>>,
}

impl<'a> MarkerGate<'a> {
    fn new(markers: &'a [String]) -> Self {
        Self {
            finders: markers
                .iter()
                .map(|marker| memmem::Finder::new(marker.as_bytes()))
                .collect(),
        }
    }

    #[inline]
    fn matches(&self, line: &[u8]) -> bool {
        self.finders
            .iter()
            .any(|finder| finder.find(line).is_some())
    }
}

/// Chunked reader providing a single line (prefix bytes + remaining bytes from `reader` up to
/// `\n` or EOF) to `project_json` without ever buffering an arbitrarily large line in RAM.
struct StreamingLineSource<'a, R: Read> {
    prefix: &'a [u8],
    prefix_pos: usize,
    chunk: &'a mut [u8],
    chunk_pos: usize,
    chunk_len: usize,
    reader: &'a mut R,
    bytes_read_from_reader: u64,
    hit_newline: bool,
    hit_eof: bool,
}

impl<'a, R: Read> StreamingLineSource<'a, R> {
    fn finish_to_eol(&mut self) -> io::Result<()> {
        if self.hit_newline || self.hit_eof {
            return Ok(());
        }
        loop {
            if self.chunk_pos < self.chunk_len {
                if let Some(rel) = memchr(b'\n', &self.chunk[self.chunk_pos..self.chunk_len]) {
                    self.chunk_pos += rel + 1;
                    self.hit_newline = true;
                    return Ok(());
                }
                self.chunk_pos = self.chunk_len;
            }
            let read = self.reader.read(self.chunk)?;
            if read == 0 {
                self.hit_eof = true;
                return Ok(());
            }
            self.bytes_read_from_reader += read as u64;
            self.chunk_pos = 0;
            self.chunk_len = read;
        }
    }
}

impl<R: Read> ByteSource for StreamingLineSource<'_, R> {
    fn peek_slice(&mut self) -> io::Result<&[u8]> {
        if self.prefix_pos < self.prefix.len() {
            return Ok(&self.prefix[self.prefix_pos..]);
        }
        if self.hit_newline || self.hit_eof {
            return Ok(&[]);
        }
        loop {
            if self.chunk_pos < self.chunk_len {
                let avail = &self.chunk[self.chunk_pos..self.chunk_len];
                if let Some(rel) = memchr(b'\n', avail) {
                    if rel == 0 {
                        self.chunk_pos += 1;
                        self.hit_newline = true;
                        return Ok(&[]);
                    }
                    // Strip trailing `\r` right before `\n`.
                    let end = if avail[rel - 1] == b'\r' {
                        rel - 1
                    } else {
                        rel
                    };
                    if end == 0 {
                        self.chunk_pos += rel + 1;
                        self.hit_newline = true;
                        return Ok(&[]);
                    }
                    return Ok(&avail[..end]);
                }
                return Ok(avail);
            }
            let read = self.reader.read(self.chunk)?;
            if read == 0 {
                self.hit_eof = true;
                return Ok(&[]);
            }
            self.bytes_read_from_reader += read as u64;
            self.chunk_pos = 0;
            self.chunk_len = read;
        }
    }

    fn consume(&mut self, count: usize) {
        if self.prefix_pos < self.prefix.len() {
            self.prefix_pos += count;
            return;
        }
        self.chunk_pos += count;
        if self.chunk_pos < self.chunk_len {
            let next = self.chunk[self.chunk_pos];
            if next == b'\n' {
                self.chunk_pos += 1;
                self.hit_newline = true;
            } else if next == b'\r'
                && self.chunk_pos + 1 < self.chunk_len
                && self.chunk[self.chunk_pos + 1] == b'\n'
            {
                self.chunk_pos += 2;
                self.hit_newline = true;
            }
        }
    }
}

#[inline]
fn strip_cr(line: &[u8]) -> &[u8] {
    if line.last() == Some(&b'\r') {
        &line[..line.len() - 1]
    } else {
        line
    }
}

fn process_buffered_line(
    raw_line: &[u8],
    gate: &MarkerGate<'_>,
    select: &SelectNode,
    scratch: &mut ProjectorScratch,
    out_lines: &mut Vec<Vec<u8>>,
) -> io::Result<()> {
    let trimmed = strip_cr(raw_line);
    if trimmed.is_empty() || !gate.matches(trimmed) {
        return Ok(());
    }
    let mut src = SliceSource::new(trimmed);
    if project_json(&mut src, select, scratch)? {
        out_lines.push(scratch.out_buf.clone());
    }
    Ok(())
}

fn scan_reader<R: Read>(
    reader: &mut R,
    start_offset: u64,
    gate: &MarkerGate<'_>,
    select: &SelectNode,
    streaming_threshold_bytes: usize,
) -> io::Result<(u64, Vec<Vec<u8>>, Option<Vec<u8>>)> {
    let mut chunk = vec![0u8; READ_CHUNK_BYTES];
    let mut chunk_pos: usize = 0;
    let mut chunk_len: usize = 0;
    let mut pending: Vec<u8> = Vec::new();
    let mut scratch = ProjectorScratch::default();
    let mut lines: Vec<Vec<u8>> = Vec::new();

    let mut scan_offset = start_offset;
    let mut resume_offset = start_offset;

    loop {
        if chunk_pos >= chunk_len {
            let read = reader.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            chunk_pos = 0;
            chunk_len = read;
            scan_offset += read as u64;
        }

        let mut chunk_start_offset = scan_offset - chunk_len as u64;

        while chunk_pos < chunk_len {
            let slice = &chunk[chunk_pos..chunk_len];
            if let Some(rel) = memchr(b'\n', slice) {
                let line_end = chunk_pos + rel;
                if pending.is_empty() {
                    process_buffered_line(
                        &chunk[chunk_pos..line_end],
                        gate,
                        select,
                        &mut scratch,
                        &mut lines,
                    )?;
                } else {
                    pending.extend_from_slice(&chunk[chunk_pos..line_end]);
                    process_buffered_line(&pending, gate, select, &mut scratch, &mut lines)?;
                    pending.clear();
                }
                chunk_pos = line_end + 1;
                resume_offset = chunk_start_offset + chunk_pos as u64;
            } else {
                // Line continues past end of current chunk.
                let remaining = &chunk[chunk_pos..chunk_len];
                if pending.len() + remaining.len() <= streaming_threshold_bytes {
                    pending.extend_from_slice(remaining);
                    chunk_pos = chunk_len;
                } else {
                    // Exceeds streaming threshold: project directly from prefix + chunk stream in O(1) RAM.
                    let mut stream_src = StreamingLineSource {
                        prefix: &pending,
                        prefix_pos: 0,
                        chunk: &mut chunk,
                        chunk_pos,
                        chunk_len,
                        reader,
                        bytes_read_from_reader: 0,
                        hit_newline: false,
                        hit_eof: false,
                    };
                    let valid = project_json(&mut stream_src, select, &mut scratch)?;
                    stream_src.finish_to_eol()?;
                    let hit_newline = stream_src.hit_newline;
                    let extra_bytes = stream_src.bytes_read_from_reader;
                    chunk_pos = stream_src.chunk_pos;
                    chunk_len = stream_src.chunk_len;
                    scan_offset += extra_bytes;
                    chunk_start_offset = scan_offset - chunk_len as u64;
                    pending.clear();

                    if hit_newline {
                        if valid {
                            lines.push(scratch.out_buf.clone());
                        }
                        resume_offset = chunk_start_offset + chunk_pos as u64;
                    } else {
                        // Unterminated oversized tail at EOF.
                        let tail = if valid {
                            Some(scratch.out_buf.clone())
                        } else {
                            None
                        };
                        return Ok((resume_offset, lines, tail));
                    }
                }
            }
        }
    }

    let mut tail: Option<Vec<u8>> = None;
    if !pending.is_empty() {
        let trimmed = strip_cr(&pending);
        if !trimmed.is_empty() && gate.matches(trimmed) {
            let mut src = SliceSource::new(trimmed);
            if project_json(&mut src, select, &mut scratch)? {
                tail = Some(scratch.out_buf.clone());
            }
        }
    }

    Ok((resume_offset, lines, tail))
}

fn scan_single_file(
    req: &ScanFileRequest,
    gate: &MarkerGate<'_>,
    select: &SelectNode,
    streaming_threshold_bytes: usize,
) -> ScanFileOutput {
    let path = Path::new(&req.path);
    let compressed = req.path.ends_with(".jsonl.zst");
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return ScanFileOutput::failed(),
    };

    if compressed {
        let mut decoder = match zstd::stream::read::Decoder::new(file) {
            Ok(dec) => dec,
            Err(_) => return ScanFileOutput::failed(),
        };
        let Ok((_, lines, tail)) =
            scan_reader(&mut decoder, 0, gate, select, streaming_threshold_bytes)
        else {
            return ScanFileOutput::failed();
        };
        return ScanFileOutput {
            ok: true,
            resumed: false,
            resume_offset: 0,
            guard_length: 0,
            guard_hash: 0,
            lines,
            tail,
        };
    }

    let mut resumed = false;
    let mut start_offset = 0u64;
    if req.resume_offset > 0 {
        if guard_matches(&mut file, req) && file.seek(SeekFrom::Start(req.resume_offset)).is_ok() {
            resumed = true;
            start_offset = req.resume_offset;
        } else if file.seek(SeekFrom::Start(0)).is_err() {
            return ScanFileOutput::failed();
        }
    }

    let Ok((resume_offset, lines, tail)) = scan_reader(
        &mut file,
        start_offset,
        gate,
        select,
        streaming_threshold_bytes,
    ) else {
        return ScanFileOutput::failed();
    };

    let Ok((guard_length, guard_hash)) = compute_guard(&mut file, resume_offset) else {
        return ScanFileOutput::failed();
    };

    ScanFileOutput {
        ok: true,
        resumed,
        resume_offset,
        guard_length,
        guard_hash,
        lines,
        tail,
    }
}

pub fn scan_batch(
    files: &[ScanFileRequest],
    usage_markers: &[String],
    select_fields: &SelectNode,
    streaming_threshold_bytes: Option<usize>,
) -> Vec<ScanFileOutput> {
    if files.is_empty() {
        return Vec::new();
    }
    let threshold = streaming_threshold_bytes.unwrap_or(DEFAULT_STREAMING_THRESHOLD_BYTES);
    let gate = MarkerGate::new(usage_markers);

    let max_threads = thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(4, 8)
        .min(files.len());

    if max_threads <= 1 {
        return files
            .iter()
            .map(|req| scan_single_file(req, &gate, select_fields, threshold))
            .collect();
    }

    let next_index = AtomicUsize::new(0);
    let slots: Vec<std::sync::Mutex<Option<ScanFileOutput>>> = (0..files.len())
        .map(|_| std::sync::Mutex::new(None))
        .collect();

    thread::scope(|scope| {
        for _ in 0..max_threads {
            scope.spawn(|| {
                loop {
                    let index = next_index.fetch_add(1, Ordering::Relaxed);
                    if index >= files.len() {
                        break;
                    }
                    let result = scan_single_file(&files[index], &gate, select_fields, threshold);
                    *slots[index].lock().unwrap() = Some(result);
                }
            });
        }
    });

    slots
        .into_iter()
        .map(|slot| slot.into_inner().unwrap().unwrap())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn claude_select() -> SelectNode {
        serde_json::from_str(
            r#"{
                "type": true,
                "timestamp": true,
                "requestId": true,
                "sessionId": true,
                "costUSD": true,
                "message": { "id": true, "model": true, "usage": true }
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn fnv1a_matches_js_reference() {
        assert_eq!(fnv1a(b""), 0x811c_9dc5);
        assert_eq!(fnv1a(b"hello"), 0x4f9f_2cab);
    }

    #[test]
    fn scans_resumes_and_handles_zstd_and_corrupt_frames() {
        let temp =
            std::env::temp_dir().join(format!("zerocode-ts-scan-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();

        let plain = temp.join("a.jsonl");
        let line1 = r#"{"type":"assistant","timestamp":"2026-08-01T10:00:00Z","message":{"id":"m1","model":"claude","usage":{"output_tokens":5}}}"#;
        let line2 = r#"{"type":"user","text":"no marker here"}"#;
        let line3 = r#"{"type":"assistant","timestamp":"2026-08-01T10:00:01Z","message":{"id":"m2","model":"claude","usage":{"output_tokens":7}}}"#;
        let part1 = format!("{line1}\r\n{line2}\r\n{line3}");
        fs::write(&plain, &part1).unwrap();

        let markers = vec!["\"usage\"".to_string()];
        let select = claude_select();
        let batch1 = scan_batch(
            &[ScanFileRequest {
                path: plain.to_string_lossy().into_owned(),
                resume_offset: 0,
                guard_length: 0,
                guard_hash: 0,
            }],
            &markers,
            &select,
            None,
        );
        assert!(batch1[0].ok);
        assert!(!batch1[0].resumed);
        assert_eq!(batch1[0].lines.len(), 1);
        assert!(batch1[0].tail.is_some());
        assert_eq!(
            batch1[0].resume_offset,
            (line1.len() + 2 + line2.len() + 2) as u64
        );

        // Append newline + line4 and resume.
        let line4 = r#"{"type":"assistant","timestamp":"2026-08-01T10:00:02Z","message":{"id":"m3","model":"claude","usage":{"output_tokens":11}}}"#;
        let mut f = fs::OpenOptions::new().append(true).open(&plain).unwrap();
        write!(f, "\r\n{line4}\n").unwrap();
        drop(f);

        let batch2 = scan_batch(
            &[ScanFileRequest {
                path: plain.to_string_lossy().into_owned(),
                resume_offset: batch1[0].resume_offset,
                guard_length: batch1[0].guard_length,
                guard_hash: batch1[0].guard_hash,
            }],
            &markers,
            &select,
            None,
        );
        assert!(batch2[0].ok);
        assert!(batch2[0].resumed);
        assert_eq!(batch2[0].lines.len(), 2);
        assert!(batch2[0].tail.is_none());

        // Compressed valid & corrupt.
        let compressed = temp.join("b.jsonl.zst");
        let zstd_bytes =
            zstd::stream::encode_all(format!("{line1}\n{line4}\n").as_bytes(), 3).unwrap();
        fs::write(&compressed, zstd_bytes).unwrap();
        let corrupt = temp.join("bad.jsonl.zst");
        fs::write(&corrupt, b"not a zstd frame").unwrap();

        let batch3 = scan_batch(
            &[
                ScanFileRequest {
                    path: compressed.to_string_lossy().into_owned(),
                    resume_offset: 10,
                    guard_length: 10,
                    guard_hash: 123,
                },
                ScanFileRequest {
                    path: corrupt.to_string_lossy().into_owned(),
                    resume_offset: 0,
                    guard_length: 0,
                    guard_hash: 0,
                },
            ],
            &markers,
            &select,
            None,
        );
        assert!(batch3[0].ok);
        assert!(!batch3[0].resumed);
        assert_eq!(batch3[0].resume_offset, 0);
        assert_eq!(batch3[0].lines.len(), 2);
        assert!(!batch3[1].ok);

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn streams_oversized_lines_above_threshold() {
        let temp =
            std::env::temp_dir().join(format!("zerocode-ts-stream-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();

        let path = temp.join("huge.jsonl");
        let pad = "x".repeat(300 * 1024);
        let huge = format!(
            r#"{{"padding":"{pad}","type":"assistant","timestamp":"2026-08-01T10:00:00Z","message":{{"id":"m1","model":"claude","usage":{{"output_tokens":42}}}}}}"#
        );
        let tail = format!(
            r#"{{"padding":"{pad}","type":"assistant","timestamp":"2026-08-01T10:00:01Z","message":{{"id":"m2","model":"claude","usage":{{"output_tokens":99}}}}}}"#
        );
        fs::write(&path, format!("{huge}\n{tail}")).unwrap();

        let markers = vec!["\"usage\"".to_string()];
        let select = claude_select();
        let res = scan_batch(
            &[ScanFileRequest {
                path: path.to_string_lossy().into_owned(),
                resume_offset: 0,
                guard_length: 0,
                guard_hash: 0,
            }],
            &markers,
            &select,
            Some(64 * 1024),
        );
        assert!(res[0].ok);
        assert_eq!(res[0].lines.len(), 1);
        assert!(res[0].tail.is_some());
        let v1: serde_json::Value = serde_json::from_slice(&res[0].lines[0]).unwrap();
        let v2: serde_json::Value = serde_json::from_slice(res[0].tail.as_ref().unwrap()).unwrap();
        assert_eq!(v1["message"]["usage"]["output_tokens"], 42);
        assert_eq!(v2["message"]["usage"]["output_tokens"], 99);
        assert_eq!(res[0].resume_offset, (huge.len() + 1) as u64);

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn tracks_resume_offset_after_streaming_line_and_handles_split_crlf() {
        let temp =
            std::env::temp_dir().join(format!("zerocode-ts-crlf-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();

        // Line 1 ends with `\r` at exact byte `READ_CHUNK_BYTES - 1`, followed by `\n` at byte `READ_CHUNK_BYTES`.
        let prefix = r#"{"type":"assistant","timestamp":"2026-08-01T10:00:00Z","message":{"id":"m1","model":"claude","usage":{"output_tokens":11}},"pad":""#;
        let suffix = r#""}"#;
        let pad_len = READ_CHUNK_BYTES - 1 - prefix.len() - suffix.len();
        let line1 = format!("{prefix}{}{suffix}\r\n", "a".repeat(pad_len));
        assert_eq!(line1.as_bytes()[READ_CHUNK_BYTES - 1], b'\r');
        assert_eq!(line1.as_bytes()[READ_CHUNK_BYTES], b'\n');

        // Line 2 is small and lives in chunk 1 right after the streamed Line 1.
        let line2 = r#"{"type":"assistant","timestamp":"2026-08-01T10:00:01Z","message":{"id":"m2","model":"claude","usage":{"output_tokens":22}}}"#;
        let tail = r#"{"type":"assistant","timestamp":"2026-08-01T10:00:02Z","message":{"id":"m3","model":"claude","usage":{"output_tokens":33}}}"#;
        let full = format!("{line1}{line2}\n{tail}");
        let path = temp.join("split-crlf.jsonl");
        fs::write(&path, &full).unwrap();

        let markers = vec!["\"usage\"".to_string()];
        let select = claude_select();
        let res = scan_batch(
            &[ScanFileRequest {
                path: path.to_string_lossy().into_owned(),
                resume_offset: 0,
                guard_length: 0,
                guard_hash: 0,
            }],
            &markers,
            &select,
            Some(0),
        );
        assert!(res[0].ok);
        assert_eq!(res[0].lines.len(), 2);
        assert!(res[0].tail.is_some());
        let expected_offset = (line1.len() + line2.len() + 1) as u64;
        assert_eq!(res[0].resume_offset, expected_offset);
        assert_eq!(res[0].guard_length, GUARD_LENGTH);
        assert_eq!(
            res[0].guard_hash,
            fnv1a(
                &full.as_bytes()
                    [(expected_offset as usize - GUARD_LENGTH)..expected_offset as usize]
            )
        );

        let _ = fs::remove_dir_all(&temp);
    }
}
