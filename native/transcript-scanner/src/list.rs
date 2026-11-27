use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::UNIX_EPOCH;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptFileEntry {
    pub path: String,
    pub size: u64,
    pub mtime_ms: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub files: Vec<TranscriptFileEntry>,
    pub walked: Vec<String>,
    pub failed_paths: usize,
}

#[inline]
fn matches_name(name: &str, file_name: Option<&str>) -> bool {
    match file_name {
        Some(expected) => name == expected,
        None => name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"),
    }
}

enum WalkItem {
    File(PathBuf),
    Subdir(PathBuf),
}

/// Walks `root` preserving exact per-directory `read_dir` order (matching Node's
/// `listTranscriptFiles` deduplication contract) while parallelizing sibling directory
/// reads and `stat()` calls across CPU cores.
pub fn list_transcript_files(root: &Path, since_ms: f64, file_name: Option<&str>) -> ListResult {
    let failed_paths = AtomicUsize::new(0);
    let max_threads = thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 16);

    let candidates = walk_dir_ordered(root, file_name, &failed_paths, max_threads);
    let walked: Vec<String> = candidates
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();

    if candidates.is_empty() {
        return ListResult {
            files: Vec::new(),
            walked,
            failed_paths: failed_paths.load(Ordering::Relaxed),
        };
    }

    let worker_count = max_threads.min(candidates.len());
    let next_index = AtomicUsize::new(0);
    let results: Vec<std::sync::Mutex<Option<TranscriptFileEntry>>> = (0..candidates.len())
        .map(|_| std::sync::Mutex::new(None))
        .collect();

    if worker_count <= 1 || candidates.len() < 16 {
        for (index, path) in candidates.iter().enumerate() {
            if let Some(entry) = stat_candidate(path, since_ms, &failed_paths) {
                *results[index].lock().unwrap() = Some(entry);
            }
        }
    } else {
        thread::scope(|scope| {
            for _ in 0..worker_count {
                scope.spawn(|| {
                    loop {
                        let index = next_index.fetch_add(1, Ordering::Relaxed);
                        if index >= candidates.len() {
                            break;
                        }
                        if let Some(entry) =
                            stat_candidate(&candidates[index], since_ms, &failed_paths)
                        {
                            *results[index].lock().unwrap() = Some(entry);
                        }
                    }
                });
            }
        });
    }

    let mut files = Vec::with_capacity(candidates.len());
    for slot in results {
        if let Some(entry) = slot.into_inner().unwrap() {
            files.push(entry);
        }
    }

    ListResult {
        files,
        walked,
        failed_paths: failed_paths.load(Ordering::Relaxed),
    }
}

fn stat_candidate(
    path: &Path,
    since_ms: f64,
    failed_paths: &AtomicUsize,
) -> Option<TranscriptFileEntry> {
    match fs::metadata(path) {
        Ok(meta) => {
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|time| match time.duration_since(UNIX_EPOCH) {
                    Ok(dur) => Some(dur.as_secs_f64() * 1_000.0),
                    Err(err) => Some(-(err.duration().as_secs_f64() * 1_000.0)),
                })
                .unwrap_or(0.0);
            if mtime_ms >= since_ms {
                Some(TranscriptFileEntry {
                    path: path.to_string_lossy().into_owned(),
                    size: meta.len(),
                    mtime_ms,
                })
            } else {
                None
            }
        }
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                failed_paths.fetch_add(1, Ordering::Relaxed);
            }
            None
        }
    }
}

fn read_dir_items(
    dir: &Path,
    file_name: Option<&str>,
    failed_paths: &AtomicUsize,
) -> Vec<WalkItem> {
    let entries = match fs::read_dir(dir) {
        Ok(iter) => iter,
        Err(_) => {
            failed_paths.fetch_add(1, Ordering::Relaxed);
            return Vec::new();
        }
    };
    let mut items: Vec<(std::ffi::OsString, WalkItem)> = Vec::new();
    for entry_result in entries {
        let Ok(entry) = entry_result else {
            failed_paths.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            failed_paths.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        let raw_name = entry.file_name();
        let path = entry.path();
        if file_type.is_dir() {
            items.push((raw_name, WalkItem::Subdir(path)));
        } else if let Some(name) = raw_name.to_str()
            && matches_name(name, file_name)
        {
            items.push((raw_name, WalkItem::File(path)));
        }
    }
    // Match libuv's uv_fs_scandir entry order so first-seen deduplication matches Node's readdir.
    items.sort_unstable_by(|a, b| a.0.as_encoded_bytes().cmp(b.0.as_encoded_bytes()));
    items.into_iter().map(|(_, item)| item).collect()
}

fn walk_dir_serial(
    dir: &Path,
    file_name: Option<&str>,
    failed_paths: &AtomicUsize,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for item in read_dir_items(dir, file_name, failed_paths) {
        match item {
            WalkItem::File(path) => out.push(path),
            WalkItem::Subdir(subdir) => {
                out.extend(walk_dir_serial(&subdir, file_name, failed_paths))
            }
        }
    }
    out
}

/// Parallelizes across top-level subdirectories (e.g. `~/.claude/projects/*` or `~/.codex/sessions/*`)
/// while collecting results back in exact `read_dir` order.
fn walk_dir_ordered(
    root: &Path,
    file_name: Option<&str>,
    failed_paths: &AtomicUsize,
    max_threads: usize,
) -> Vec<PathBuf> {
    let top_items = read_dir_items(root, file_name, failed_paths);
    let subdir_count = top_items
        .iter()
        .filter(|item| matches!(item, WalkItem::Subdir(_)))
        .count();

    if subdir_count <= 1 || max_threads <= 1 {
        let mut out = Vec::new();
        for item in top_items {
            match item {
                WalkItem::File(path) => out.push(path),
                WalkItem::Subdir(subdir) => {
                    out.extend(walk_dir_serial(&subdir, file_name, failed_paths));
                }
            }
        }
        return out;
    }

    let worker_count = max_threads.min(subdir_count);
    let next_index = AtomicUsize::new(0);
    let slots: Vec<std::sync::Mutex<Vec<PathBuf>>> = (0..top_items.len())
        .map(|_| std::sync::Mutex::new(Vec::new()))
        .collect();

    thread::scope(|scope| {
        for _ in 0..worker_count {
            scope.spawn(|| {
                loop {
                    let index = next_index.fetch_add(1, Ordering::Relaxed);
                    if index >= top_items.len() {
                        break;
                    }
                    match &top_items[index] {
                        WalkItem::File(path) => {
                            slots[index].lock().unwrap().push(path.clone());
                        }
                        WalkItem::Subdir(subdir) => {
                            let found = walk_dir_serial(subdir, file_name, failed_paths);
                            *slots[index].lock().unwrap() = found;
                        }
                    }
                }
            });
        }
    });

    let mut out = Vec::new();
    for slot in slots {
        out.extend(slot.into_inner().unwrap());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_directory_order_and_filters_extensions() {
        let temp =
            std::env::temp_dir().join(format!("zerocode-ts-list-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        for index in 0..24 {
            let sub = temp.join(format!("project-{index}")).join("sessions");
            fs::create_dir_all(&sub).unwrap();
            fs::write(sub.join("a.jsonl"), "{}\n").unwrap();
            fs::write(sub.join("b.jsonl.zst"), "x").unwrap();
            fs::write(sub.join("ignore.txt"), "x").unwrap();
        }

        let listed = list_transcript_files(&temp, 0.0, None);
        assert_eq!(listed.failed_paths, 0);
        assert_eq!(listed.files.len(), 48);
        assert_eq!(listed.walked.len(), 48);

        let serial = walk_dir_serial(&temp, None, &AtomicUsize::new(0));
        let serial_strings: Vec<String> = serial
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(listed.walked, serial_strings);

        let named = list_transcript_files(&temp, 0.0, Some("a.jsonl"));
        assert_eq!(named.files.len(), 24);

        let _ = fs::remove_dir_all(&temp);
    }
}
