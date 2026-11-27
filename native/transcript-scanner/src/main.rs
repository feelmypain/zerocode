mod json_project;
mod list;
mod scanner;
mod session_scan;

use std::io::{self, BufRead, BufWriter, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Deserialize;

use crate::json_project::SelectNode;
use crate::list::list_transcript_files;
use crate::scanner::{ScanFileOutput, ScanFileRequest, scan_batch};

const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Command {
    List {
        version: u32,
        id: u64,
        root: String,
        since_ms: f64,
        #[serde(default)]
        file_name: Option<String>,
    },
    ScanBatch {
        version: u32,
        id: u64,
        usage_markers: Vec<String>,
        select_fields: SelectNode,
        #[serde(default)]
        streaming_threshold_bytes: Option<usize>,
        files: Vec<ScanFileRequest>,
    },
    Shutdown {
        version: u32,
        id: u64,
    },
}

fn write_error(out: &mut impl Write, id: u64, message: &str) -> io::Result<()> {
    out.write_all(b"{\"id\":")?;
    write!(out, "{id}")?;
    out.write_all(b",\"ok\":false,\"error\":")?;
    serde_json::to_writer(&mut *out, message)
        .map_err(|err| io::Error::new(io::ErrorKind::Other, err))?;
    out.write_all(b"}\n")?;
    out.flush()
}

/// Emits scan results directly as raw JSON so projected values (including non-finite
/// JSON numbers like `1e400`) cross the IPC boundary in a single `JSON.parse` on Node.
fn write_scan_batch_response(
    out: &mut impl Write,
    id: u64,
    results: &[ScanFileOutput],
) -> io::Result<()> {
    write!(out, "{{\"id\":{id},\"ok\":true,\"results\":[")?;
    for (idx, file) in results.iter().enumerate() {
        if idx > 0 {
            out.write_all(b",")?;
        }
        if !file.ok {
            out.write_all(b"{\"ok\":false}")?;
            continue;
        }
        write!(
            out,
            "{{\"ok\":true,\"resumed\":{},\"resumeOffset\":{},\"guardLength\":{},\"guardHash\":{},\"lines\":[",
            file.resumed, file.resume_offset, file.guard_length, file.guard_hash
        )?;
        for (line_idx, line_bytes) in file.lines.iter().enumerate() {
            if line_idx > 0 {
                out.write_all(b",")?;
            }
            out.write_all(line_bytes)?;
        }
        out.write_all(b"],\"tail\":")?;
        match &file.tail {
            Some(tail_bytes) => out.write_all(tail_bytes)?,
            None => out.write_all(b"null")?,
        }
        out.write_all(b"}")?;
    }
    out.write_all(b"]}\n")?;
    out.flush()
}

fn main() {
    let mut args = std::env::args();
    let _exe = args.next();
    if let Some(subcommand) = args.next() {
        match subcommand.as_str() {
            "session-scan" => {
                if let Err(err) = session_scan::run_cli() {
                    eprintln!("session-scan error: {err}");
                    std::process::exit(1);
                }
                return;
            }
            other => {
                eprintln!("unknown subcommand: {other}");
                std::process::exit(2);
            }
        }
    }

    let stdin = io::stdin();
    let mut reader = io::BufReader::new(stdin.lock());
    let writer = Arc::new(Mutex::new(BufWriter::with_capacity(
        256 * 1024,
        io::stdout(),
    )));
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let command: Command = match serde_json::from_str(trimmed) {
            Ok(cmd) => cmd,
            Err(err) => {
                if let Ok(mut out) = writer.lock() {
                    let _ = write_error(&mut *out, 0, &format!("invalid command: {err}"));
                }
                continue;
            }
        };

        match command {
            Command::List {
                version,
                id,
                root,
                since_ms,
                file_name,
            } => {
                if version != PROTOCOL_VERSION {
                    if let Ok(mut out) = writer.lock() {
                        let _ = write_error(&mut *out, id, "unsupported protocol version");
                    }
                    continue;
                }
                // Dispatch off the stdin loop so fast scans never block behind a slow window scan.
                let writer = Arc::clone(&writer);
                thread::spawn(move || {
                    let result =
                        list_transcript_files(Path::new(&root), since_ms, file_name.as_deref());
                    if let Ok(mut out) = writer.lock() {
                        let _ = (|| -> io::Result<()> {
                            write!(&mut *out, "{{\"id\":{id},\"ok\":true,\"result\":")?;
                            serde_json::to_writer(&mut *out, &result)
                                .map_err(|err| io::Error::new(io::ErrorKind::Other, err))?;
                            out.write_all(b"}\n")?;
                            out.flush()
                        })();
                    }
                });
            }
            Command::ScanBatch {
                version,
                id,
                usage_markers,
                select_fields,
                streaming_threshold_bytes,
                files,
            } => {
                if version != PROTOCOL_VERSION {
                    if let Ok(mut out) = writer.lock() {
                        let _ = write_error(&mut *out, id, "unsupported protocol version");
                    }
                    continue;
                }
                let writer = Arc::clone(&writer);
                thread::spawn(move || {
                    let results = scan_batch(
                        &files,
                        &usage_markers,
                        &select_fields,
                        streaming_threshold_bytes,
                    );
                    if let Ok(mut out) = writer.lock() {
                        let _ = write_scan_batch_response(&mut *out, id, &results);
                    }
                });
            }
            Command::Shutdown { version, id } => {
                if version != PROTOCOL_VERSION {
                    if let Ok(mut out) = writer.lock() {
                        let _ = write_error(&mut *out, id, "unsupported protocol version");
                    }
                    continue;
                }
                if let Ok(mut out) = writer.lock() {
                    let _ = writeln!(&mut *out, "{{\"id\":{id},\"ok\":true}}");
                    let _ = out.flush();
                }
                break;
            }
        }
    }
}
