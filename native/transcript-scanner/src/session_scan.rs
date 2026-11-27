use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use memchr::{memchr, memchr2};
use serde::{Deserialize, Serialize};

pub const SESSION_SCAN_PROTOCOL_VERSION: u32 = 1;

const DEFAULT_MAX_DISCOVERY_OPERATIONS: usize = 20_000;
const DEFAULT_MAX_TRANSCRIPTS: usize = 5_000;
const DEFAULT_MAX_METADATA_BYTES: u64 = 64 * 1024 * 1024;
const DEFAULT_MAX_METADATA_OPERATIONS: usize = 20_000;
const DEFAULT_MAX_METADATA_RECORDS: usize = 100_000;
const DEFAULT_MAX_METADATA_RECORDS_PER_TRANSCRIPT: usize = 1_000;
const DEFAULT_MAX_TRANSCRIPT_SCAN_BYTES: usize = 1024 * 1024;
const DEFAULT_METADATA_READ_CHUNK_BYTES: usize = 8 * 1024;
const DEFAULT_READ_DEADLINE_MS: u64 = 2_000;
const DEFAULT_MAX_GIT_FILE_BYTES: usize = 1024 * 1024;
const MAX_JSON_DEPTH: usize = 128;
const MAX_THREADS_CAP: usize = 16;

fn default_max_discovery_operations() -> usize {
    DEFAULT_MAX_DISCOVERY_OPERATIONS
}
fn default_max_transcripts() -> usize {
    DEFAULT_MAX_TRANSCRIPTS
}
fn default_max_metadata_bytes() -> u64 {
    DEFAULT_MAX_METADATA_BYTES
}
fn default_max_metadata_operations() -> usize {
    DEFAULT_MAX_METADATA_OPERATIONS
}
fn default_max_metadata_records() -> usize {
    DEFAULT_MAX_METADATA_RECORDS
}
fn default_max_metadata_records_per_transcript() -> usize {
    DEFAULT_MAX_METADATA_RECORDS_PER_TRANSCRIPT
}
fn default_max_transcript_scan_bytes() -> usize {
    DEFAULT_MAX_TRANSCRIPT_SCAN_BYTES
}
fn default_metadata_read_chunk_bytes() -> usize {
    DEFAULT_METADATA_READ_CHUNK_BYTES
}
fn default_read_deadline_ms() -> u64 {
    DEFAULT_READ_DEADLINE_MS
}
fn default_max_git_file_bytes() -> usize {
    DEFAULT_MAX_GIT_FILE_BYTES
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderSource {
    ClaudeAgent,
    Codex,
    Pi,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceHome {
    pub provider_instance_id: String,
    pub home_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLimits {
    #[serde(default = "default_max_discovery_operations")]
    pub max_discovery_operations: usize,
    #[serde(default = "default_max_transcripts")]
    pub max_transcripts: usize,
    #[serde(default = "default_max_metadata_bytes")]
    pub max_metadata_bytes: u64,
    #[serde(default = "default_max_metadata_operations")]
    pub max_metadata_operations: usize,
    #[serde(default = "default_max_metadata_records")]
    pub max_metadata_records: usize,
    #[serde(default = "default_max_metadata_records_per_transcript")]
    pub max_metadata_records_per_transcript: usize,
    #[serde(default = "default_max_transcript_scan_bytes")]
    pub max_transcript_scan_bytes: usize,
    #[serde(default = "default_metadata_read_chunk_bytes")]
    pub metadata_read_chunk_bytes: usize,
}

impl Default for SourceLimits {
    fn default() -> Self {
        Self {
            max_discovery_operations: DEFAULT_MAX_DISCOVERY_OPERATIONS,
            max_transcripts: DEFAULT_MAX_TRANSCRIPTS,
            max_metadata_bytes: DEFAULT_MAX_METADATA_BYTES,
            max_metadata_operations: DEFAULT_MAX_METADATA_OPERATIONS,
            max_metadata_records: DEFAULT_MAX_METADATA_RECORDS,
            max_metadata_records_per_transcript: DEFAULT_MAX_METADATA_RECORDS_PER_TRANSCRIPT,
            max_transcript_scan_bytes: DEFAULT_MAX_TRANSCRIPT_SCAN_BYTES,
            metadata_read_chunk_bytes: DEFAULT_METADATA_READ_CHUNK_BYTES,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedHint {
    pub provider_instance_id: String,
    pub file_path: String,
    pub cwd: String,
    pub size: u64,
    pub mtime_ms: Option<i64>,
    pub device: u64,
    pub inode: Option<String>,
    pub birthtime_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceScanRequest {
    pub source: ProviderSource,
    #[serde(default)]
    pub homes: Vec<SourceHome>,
    #[serde(default)]
    pub limits: SourceLimits,
    #[serde(default)]
    pub cached_hints: Vec<CachedHint>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionScanRequest {
    pub version: u32,
    #[serde(default)]
    pub max_threads: Option<usize>,
    #[serde(default = "default_read_deadline_ms")]
    pub read_deadline_ms: u64,
    #[serde(default = "default_max_git_file_bytes")]
    pub max_git_file_bytes: usize,
    #[serde(default)]
    pub sources: Vec<SourceScanRequest>,
    #[serde(default)]
    pub git_directories: Vec<String>,
    #[serde(default)]
    pub blocked_git_paths: Vec<String>,
    #[serde(default)]
    pub head_git_dirs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedTranscript {
    pub file_path: String,
    pub provider_instance_id: String,
    pub home_path: String,
    pub mtime_ms: i64,
    pub size: u64,
    pub device: u64,
    pub inode: Option<String>,
    pub birthtime_ms: Option<i64>,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceScanResult {
    pub source: ProviderSource,
    pub truncated: bool,
    pub metadata_truncated: bool,
    pub transcripts: Vec<ScannedTranscript>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitIdentityKind {
    Repository,
    Worktree,
    NotGit,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDirectoryIdentity {
    pub directory: String,
    pub kind: GitIdentityKind,
    pub git_dir: Option<String>,
    pub main_checkout: Option<String>,
    pub origin_url: Option<String>,
    pub is_bare: bool,
    pub config_present: bool,
    pub has_git: bool,
    pub head_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadBranchResult {
    pub git_dir: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionScanResponse {
    pub version: u32,
    pub ok: bool,
    pub sources: Vec<SourceScanResult>,
    pub git_identities: Vec<GitDirectoryIdentity>,
    pub head_branches: Vec<HeadBranchResult>,
    pub timed_out_git_paths: Vec<String>,
}

pub fn run_cli() -> Result<(), String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|err| format!("failed to read stdin: {err}"))?;
    let request: SessionScanRequest =
        serde_json::from_str(&input).map_err(|err| format!("invalid request JSON: {err}"))?;
    if request.version != SESSION_SCAN_PROTOCOL_VERSION {
        return Err(format!("unsupported protocol version: {}", request.version));
    }

    let response = run_session_scan(&request);
    let stdout = io::stdout();
    let mut out = io::BufWriter::with_capacity(256 * 1024, stdout.lock());
    serde_json::to_writer(&mut out, &response)
        .map_err(|err| format!("failed to serialize response: {err}"))?;
    out.write_all(b"\n")
        .map_err(|err| format!("failed to write newline: {err}"))?;
    out.flush()
        .map_err(|err| format!("failed to flush stdout: {err}"))?;
    Ok(())
}

pub fn run_session_scan(request: &SessionScanRequest) -> SessionScanResponse {
    let max_threads = request
        .max_threads
        .unwrap_or_else(|| {
            thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4)
        })
        .clamp(1, MAX_THREADS_CAP);
    let read_deadline_ms = request.read_deadline_ms;
    let max_git_file_bytes = request.max_git_file_bytes.clamp(1, 16 * 1024 * 1024);

    let sources: Vec<SourceScanResult> = request
        .sources
        .iter()
        .map(|src_req| scan_provider_source(src_req, max_threads))
        .collect();

    let blocked_set: HashSet<String> = request.blocked_git_paths.iter().cloned().collect();
    let mut timed_out_git_paths: Vec<String> = Vec::new();

    let git_identities = if request.git_directories.is_empty() {
        Vec::new()
    } else {
        resolve_git_identities(
            &request.git_directories,
            &blocked_set,
            read_deadline_ms,
            max_git_file_bytes,
            max_threads,
            &mut timed_out_git_paths,
        )
    };

    let head_branches = if request.head_git_dirs.is_empty() {
        Vec::new()
    } else {
        read_head_branches(
            &request.head_git_dirs,
            &blocked_set,
            read_deadline_ms,
            max_git_file_bytes,
            max_threads,
            &mut timed_out_git_paths,
        )
    };

    SessionScanResponse {
        version: SESSION_SCAN_PROTOCOL_VERSION,
        ok: true,
        sources,
        git_identities,
        head_branches,
        timed_out_git_paths,
    }
}

#[derive(Debug, Clone)]
struct DiscoveredTranscript {
    file_path: String,
    provider_instance_id: String,
    home_path: String,
    mtime_ms: i64,
    size: u64,
    device: u64,
    inode: Option<String>,
    birthtime_ms: Option<i64>,
}

struct HomeDiscoveryResult {
    transcripts: Vec<DiscoveredTranscript>,
    truncated: bool,
    operations_used: usize,
}

fn system_time_to_ms(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(dur) => (dur.as_secs() as i64)
            .saturating_mul(1_000)
            .saturating_add((dur.subsec_nanos() / 1_000_000) as i64),
        Err(err) => {
            let dur = err.duration();
            -((dur.as_secs() as i64)
                .saturating_mul(1_000)
                .saturating_add((dur.subsec_nanos() / 1_000_000) as i64))
        }
    }
}

#[cfg(unix)]
fn unix_timespec_to_ms(sec: i64, nsec: i64) -> i64 {
    let total_ns = (sec as i128) * 1_000_000_000 + (nsec as i128);
    (total_ns / 1_000_000) as i64
}

fn metadata_birthtime_ms(meta: &fs::Metadata) -> Option<i64> {
    if let Ok(created) = meta.created() {
        return Some(system_time_to_ms(created));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(unix_timespec_to_ms(meta.ctime(), meta.ctime_nsec()))
    }
    #[cfg(not(unix))]
    {
        None
    }
}

fn metadata_device_and_inode(meta: &fs::Metadata) -> (u64, Option<String>) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (meta.dev(), Some(meta.ino().to_string()))
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        (0, None)
    }
}

fn stat_transcript_file(
    file_path: &Path,
    provider_instance_id: &str,
    home_path: &str,
) -> Option<DiscoveredTranscript> {
    let meta = fs::metadata(file_path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime_ms = system_time_to_ms(meta.modified().ok()?);
    let (device, inode) = metadata_device_and_inode(&meta);
    Some(DiscoveredTranscript {
        file_path: file_path.to_string_lossy().into_owned(),
        provider_instance_id: provider_instance_id.to_string(),
        home_path: home_path.to_string(),
        mtime_ms,
        size: meta.len(),
        device,
        inode,
        birthtime_ms: metadata_birthtime_ms(&meta),
    })
}

fn list_dir_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names
}

fn split_operation_budget(budget: usize, count: usize) -> Vec<usize> {
    if count == 0 {
        return Vec::new();
    }
    let base = budget / count;
    let rem = budget % count;
    (0..count)
        .map(|idx| base + usize::from(idx < rem))
        .collect()
}

fn discover_claude_home(
    home_path: &str,
    provider_instance_id: &str,
    operation_budget: usize,
    max_threads: usize,
) -> HomeDiscoveryResult {
    let projects_dir = Path::new(home_path).join("projects");
    let mut operations_remaining = operation_budget;
    let mut truncated = false;

    if operations_remaining == 0 {
        return HomeDiscoveryResult {
            transcripts: Vec::new(),
            truncated: true,
            operations_used: 0,
        };
    }
    operations_remaining -= 1;
    let raw_names = list_dir_names(&projects_dir);

    let to_date_len = raw_names.len().min(operation_budget);
    let to_date = &raw_names[..to_date_len];
    let undated = &raw_names[to_date_len..];

    let mut dated: Vec<(String, i64)> = if to_date_len >= 64 && max_threads > 1 {
        let worker_count = max_threads.min(to_date_len);
        let next_idx = AtomicUsize::new(0);
        let slots: Vec<std::sync::Mutex<Option<(String, i64)>>> = (0..to_date_len)
            .map(|_| std::sync::Mutex::new(None))
            .collect();
        thread::scope(|scope| {
            for _ in 0..worker_count {
                scope.spawn(|| {
                    loop {
                        let idx = next_idx.fetch_add(1, Ordering::Relaxed);
                        if idx >= to_date_len {
                            break;
                        }
                        let name = &to_date[idx];
                        if let Ok(meta) = fs::metadata(projects_dir.join(name))
                            && meta.is_dir()
                        {
                            let mtime = meta.modified().ok().map(system_time_to_ms).unwrap_or(0);
                            *slots[idx].lock().unwrap() = Some((name.clone(), mtime));
                        }
                    }
                });
            }
        });
        slots
            .into_iter()
            .filter_map(|slot| slot.into_inner().unwrap())
            .collect()
    } else {
        let mut out = Vec::with_capacity(to_date_len);
        for name in to_date {
            if let Ok(meta) = fs::metadata(projects_dir.join(name))
                && meta.is_dir()
            {
                let mtime = meta.modified().ok().map(system_time_to_ms).unwrap_or(0);
                out.push((name.clone(), mtime));
            }
        }
        out
    };

    dated.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    let mut project_dirs: Vec<String> = Vec::with_capacity(dated.len() + undated.len());
    project_dirs.extend(dated.into_iter().map(|(name, _)| name));
    project_dirs.extend(undated.iter().cloned());

    let mut transcripts = Vec::new();
    for project_dir in project_dirs {
        if operations_remaining == 0 {
            truncated = true;
            break;
        }
        operations_remaining -= 1;
        let dir = projects_dir.join(&project_dir);
        let file_paths: Vec<PathBuf> = list_dir_names(&dir)
            .into_iter()
            .filter(|name| name.ends_with(".jsonl"))
            .map(|name| dir.join(name))
            .collect();

        let take_count = if file_paths.len() > operations_remaining {
            truncated = true;
            let count = operations_remaining;
            operations_remaining = 0;
            count
        } else {
            operations_remaining -= file_paths.len();
            file_paths.len()
        };

        let slice = &file_paths[..take_count];
        if slice.len() >= 64 && max_threads > 1 {
            let worker_count = max_threads.min(slice.len());
            let next_idx = AtomicUsize::new(0);
            let slots: Vec<std::sync::Mutex<Option<DiscoveredTranscript>>> = (0..slice.len())
                .map(|_| std::sync::Mutex::new(None))
                .collect();
            thread::scope(|scope| {
                for _ in 0..worker_count {
                    scope.spawn(|| {
                        loop {
                            let idx = next_idx.fetch_add(1, Ordering::Relaxed);
                            if idx >= slice.len() {
                                break;
                            }
                            if let Some(entry) =
                                stat_transcript_file(&slice[idx], provider_instance_id, home_path)
                            {
                                *slots[idx].lock().unwrap() = Some(entry);
                            }
                        }
                    });
                }
            });
            for slot in slots {
                if let Some(entry) = slot.into_inner().unwrap() {
                    transcripts.push(entry);
                }
            }
        } else {
            for file_path in slice {
                if let Some(entry) = stat_transcript_file(file_path, provider_instance_id, home_path)
                {
                    transcripts.push(entry);
                }
            }
        }

        if truncated {
            break;
        }
    }

    HomeDiscoveryResult {
        transcripts,
        truncated,
        operations_used: operation_budget - operations_remaining,
    }
}

fn is_compressed_transcript(name: &str) -> bool {
    name.ends_with(".jsonl.zst")
}

fn discover_codex_home(
    home_path: &str,
    provider_instance_id: &str,
    operation_budget: usize,
) -> HomeDiscoveryResult {
    let sessions_dir = Path::new(home_path).join("sessions");
    let mut operations_remaining = operation_budget;
    let mut truncated = false;
    let mut transcripts = Vec::new();

    let read_sorted_desc = |dir: &Path, ops: &mut usize, trunc: &mut bool| -> Vec<String> {
        if *ops == 0 {
            *trunc = true;
            return Vec::new();
        }
        *ops -= 1;
        let mut names = list_dir_names(dir);
        names.sort_unstable();
        names.reverse();
        names
    };

    let years = read_sorted_desc(&sessions_dir, &mut operations_remaining, &mut truncated);
    for year in years {
        if operations_remaining == 0 {
            truncated = true;
            break;
        }
        let year_dir = sessions_dir.join(&year);
        let months = read_sorted_desc(&year_dir, &mut operations_remaining, &mut truncated);
        for month in months {
            if operations_remaining == 0 {
                truncated = true;
                break;
            }
            let month_dir = year_dir.join(&month);
            let days = read_sorted_desc(&month_dir, &mut operations_remaining, &mut truncated);
            for day in days {
                if operations_remaining == 0 {
                    truncated = true;
                    break;
                }
                let day_dir = month_dir.join(&day);
                let entries = read_sorted_desc(&day_dir, &mut operations_remaining, &mut truncated);
                for entry in entries {
                    if !entry.starts_with("rollout-")
                        || !(entry.ends_with(".jsonl") || is_compressed_transcript(&entry))
                    {
                        continue;
                    }
                    if operations_remaining == 0 {
                        truncated = true;
                        break;
                    }
                    operations_remaining -= 1;
                    let file_path = day_dir.join(&entry);
                    if let Some(t) =
                        stat_transcript_file(&file_path, provider_instance_id, home_path)
                    {
                        transcripts.push(t);
                    }
                }
                if truncated {
                    break;
                }
            }
            if truncated {
                break;
            }
        }
        if truncated {
            break;
        }
    }

    HomeDiscoveryResult {
        transcripts,
        truncated,
        operations_used: operation_budget - operations_remaining,
    }
}

fn discover_pi_home(
    sessions_dir: &str,
    provider_instance_id: &str,
    operation_budget: usize,
) -> HomeDiscoveryResult {
    let root = Path::new(sessions_dir);
    let mut operations_remaining = operation_budget;
    let mut truncated = false;
    let mut transcripts = Vec::new();

    if operations_remaining == 0 {
        return HomeDiscoveryResult {
            transcripts,
            truncated: true,
            operations_used: 0,
        };
    }
    operations_remaining -= 1;
    let top_entries = list_dir_names(root);

    for entry in top_entries {
        if operations_remaining == 0 {
            truncated = true;
            break;
        }
        let entry_path = root.join(&entry);
        let file_paths = if entry.ends_with(".jsonl") {
            vec![entry_path]
        } else {
            operations_remaining -= 1;
            list_dir_names(&entry_path)
                .into_iter()
                .filter(|nested| nested.ends_with(".jsonl"))
                .map(|nested| entry_path.join(nested))
                .collect()
        };

        for file_path in file_paths {
            if operations_remaining == 0 {
                truncated = true;
                break;
            }
            operations_remaining -= 1;
            if let Some(t) = stat_transcript_file(&file_path, provider_instance_id, sessions_dir) {
                transcripts.push(t);
            }
        }
        if truncated {
            break;
        }
    }

    HomeDiscoveryResult {
        transcripts,
        truncated,
        operations_used: operation_budget - operations_remaining,
    }
}

fn discover_home(
    source: ProviderSource,
    home: &SourceHome,
    budget: usize,
    max_threads: usize,
) -> HomeDiscoveryResult {
    if budget == 0 {
        return HomeDiscoveryResult {
            transcripts: Vec::new(),
            truncated: true,
            operations_used: 0,
        };
    }
    match source {
        ProviderSource::ClaudeAgent => {
            discover_claude_home(&home.home_path, &home.provider_instance_id, budget, max_threads)
        }
        ProviderSource::Codex => {
            discover_codex_home(&home.home_path, &home.provider_instance_id, budget)
        }
        ProviderSource::Pi => discover_pi_home(&home.home_path, &home.provider_instance_id, budget),
    }
}

fn select_metadata_transcripts(
    transcripts: Vec<DiscoveredTranscript>,
    max_transcripts: usize,
) -> Vec<DiscoveredTranscript> {
    let mut order: Vec<String> = Vec::new();
    let mut grouped: HashMap<String, std::collections::VecDeque<DiscoveredTranscript>> =
        HashMap::new();
    for t in transcripts {
        if !grouped.contains_key(&t.provider_instance_id) {
            order.push(t.provider_instance_id.clone());
        }
        grouped
            .entry(t.provider_instance_id.clone())
            .or_default()
            .push_back(t);
    }

    let mut selected = Vec::with_capacity(max_transcripts.min(grouped.values().map(|v| v.len()).sum()));
    let mut active_keys = order;
    while !active_keys.is_empty() && selected.len() < max_transcripts {
        let mut next_round = Vec::with_capacity(active_keys.len());
        for key in active_keys {
            if selected.len() == max_transcripts {
                break;
            }
            if let Some(queue) = grouped.get_mut(&key)
                && let Some(item) = queue.pop_front()
            {
                selected.push(item);
                if !queue.is_empty() {
                    next_round.push(key);
                }
            }
        }
        active_keys = next_round;
    }
    selected
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CwdOutcome {
    Found(String),
    Excluded,
    NotFound,
}

#[derive(Debug, Clone)]
struct CwdScanMetrics {
    outcome: CwdOutcome,
    bytes_charged: u64,
    operations_used: usize,
    records_used: usize,
    truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ObjectRole {
    Root,
    Payload,
    PayloadSource,
    Ignore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ObjExpect {
    KeyOrEnd,
    Key,
    Colon,
    Value,
    CommaOrEnd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArrExpect {
    ValueOrEnd,
    Value,
    CommaOrEnd,
}

#[derive(Debug, Clone, Copy)]
enum Container {
    Object { expect: ObjExpect, role: ObjectRole },
    Array { expect: ArrExpect },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TargetSlot {
    None,
    Key,
    TopCwd,
    TopType,
    PayloadCwd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NumStage {
    AfterMinus,
    AfterZero,
    IntDigits,
    FracStart,
    FracDigits,
    ExpSignOrDigit,
    ExpStart,
    ExpDigits,
}

#[derive(Debug, Clone)]
enum TokenState {
    Idle,
    String {
        capture: bool,
        slot: TargetSlot,
        escaped: bool,
        unicode_rem: u8,
        unicode_acc: u16,
        high_surrogate: Option<u16>,
        pending_backslash_after_surrogate: bool,
        utf8_buf: [u8; 4],
        utf8_len: u8,
    },
    Number {
        stage: NumStage,
    },
    Literal {
        expected: &'static [u8],
        pos: usize,
    },
}

/// Streaming RFC 8259 JSON line scanner that extracts only `cwd`, `type`, `payload.cwd`,
/// and `payload.source.{subagent,subAgent}` in O(1) memory for discarded payloads.
struct CwdLineParser {
    source: ProviderSource,
    max_selected_bytes: usize,
    selected_bytes: usize,
    stack: Vec<Container>,
    token: TokenState,
    buf: String,
    active_key_role: Option<ObjectRole>,
    pending_slot: TargetSlot,
    pending_object_role: ObjectRole,
    root_started: bool,
    root_complete: bool,
    malformed: bool,
    limit_exceeded: bool,
    early_cwd: Option<String>,
    top_cwd: Option<String>,
    top_type: Option<String>,
    payload_cwd: Option<String>,
    payload_source_has_subagent: bool,
}

impl CwdLineParser {
    fn new(source: ProviderSource, max_selected_bytes: usize) -> Self {
        Self {
            source,
            max_selected_bytes,
            selected_bytes: 0,
            stack: Vec::with_capacity(16),
            token: TokenState::Idle,
            buf: String::new(),
            active_key_role: None,
            pending_slot: TargetSlot::None,
            pending_object_role: ObjectRole::Ignore,
            root_started: false,
            root_complete: false,
            malformed: false,
            limit_exceeded: false,
            early_cwd: None,
            top_cwd: None,
            top_type: None,
            payload_cwd: None,
            payload_source_has_subagent: false,
        }
    }

    fn reset(&mut self) {
        self.selected_bytes = 0;
        self.stack.clear();
        self.token = TokenState::Idle;
        self.buf.clear();
        self.active_key_role = None;
        self.pending_slot = TargetSlot::None;
        self.pending_object_role = ObjectRole::Ignore;
        self.root_started = false;
        self.root_complete = false;
        self.malformed = false;
        self.limit_exceeded = false;
        self.early_cwd = None;
        self.top_cwd = None;
        self.top_type = None;
        self.payload_cwd = None;
        self.payload_source_has_subagent = false;
    }

    fn reserve_selected(&mut self, bytes: usize) -> bool {
        self.selected_bytes = self.selected_bytes.saturating_add(bytes);
        if self.selected_bytes > self.max_selected_bytes {
            self.limit_exceeded = true;
            return false;
        }
        true
    }

    fn push_captured_char(&mut self, ch: char) -> bool {
        if !self.reserve_selected(ch.len_utf16() * 2) {
            return false;
        }
        self.buf.push(ch);
        true
    }

    fn push_captured_str(&mut self, text: &str) -> bool {
        let utf16_bytes = text.len().saturating_mul(2);
        if !self.reserve_selected(utf16_bytes) {
            return false;
        }
        self.buf.push_str(text);
        true
    }

    fn push_captured_bytes(
        &mut self,
        bytes: &[u8],
        utf8_buf: &mut [u8; 4],
        utf8_len: &mut u8,
        flush_tail: bool,
    ) -> bool {
        let mut rest = bytes;
        if *utf8_len > 0 {
            while (*utf8_len as usize) < 4 && !rest.is_empty() {
                utf8_buf[*utf8_len as usize] = rest[0];
                *utf8_len += 1;
                rest = &rest[1..];
                match std::str::from_utf8(&utf8_buf[..*utf8_len as usize]) {
                    Ok(valid) => {
                        if !self.push_captured_str(valid) {
                            return false;
                        }
                        *utf8_len = 0;
                        break;
                    }
                    Err(err) => {
                        if let Some(bad) = err.error_len() {
                            if !self.push_captured_char('\u{FFFD}') {
                                return false;
                            }
                            let rem = *utf8_len as usize - bad;
                            utf8_buf.copy_within(bad..*utf8_len as usize, 0);
                            *utf8_len = rem as u8;
                            if rem == 0 {
                                break;
                            }
                            if let Ok(valid) = std::str::from_utf8(&utf8_buf[..rem]) {
                                let owned = valid.to_string();
                                if !self.push_captured_str(&owned) {
                                    return false;
                                }
                                *utf8_len = 0;
                                break;
                            }
                        }
                    }
                }
            }
            if *utf8_len > 0 && flush_tail {
                let tail = String::from_utf8_lossy(&utf8_buf[..*utf8_len as usize]).into_owned();
                *utf8_len = 0;
                if !self.push_captured_str(&tail) {
                    return false;
                }
            }
            if rest.is_empty() {
                return true;
            }
        }

        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => return self.push_captured_str(valid),
                Err(err) => {
                    let valid_len = err.valid_up_to();
                    if valid_len > 0 {
                        let valid = std::str::from_utf8(&rest[..valid_len]).unwrap();
                        if !self.push_captured_str(valid) {
                            return false;
                        }
                    }
                    match err.error_len() {
                        Some(bad) => {
                            if !self.push_captured_char('\u{FFFD}') {
                                return false;
                            }
                            rest = &rest[valid_len + bad..];
                        }
                        None => {
                            let tail = &rest[valid_len..];
                            if flush_tail {
                                if !self.push_captured_char('\u{FFFD}') {
                                    return false;
                                }
                            } else {
                                utf8_buf[..tail.len()].copy_from_slice(tail);
                                *utf8_len = tail.len() as u8;
                            }
                            return true;
                        }
                    }
                }
            }
        }
    }

    fn complete_value(&mut self) {
        if self.stack.is_empty() {
            self.root_complete = true;
            return;
        }
        match self.stack.last_mut() {
            Some(Container::Object { expect, .. }) => *expect = ObjExpect::CommaOrEnd,
            Some(Container::Array { expect }) => *expect = ArrExpect::CommaOrEnd,
            None => {}
        }
    }

    fn finish_string(&mut self, slot: TargetSlot) {
        match slot {
            TargetSlot::Key => {
                let role = self.active_key_role.unwrap_or(ObjectRole::Ignore);
                self.pending_slot = TargetSlot::None;
                self.pending_object_role = ObjectRole::Ignore;
                match role {
                    ObjectRole::Root => match self.buf.as_str() {
                        "cwd" => {
                            self.top_cwd = None;
                            self.pending_slot = TargetSlot::TopCwd;
                        }
                        "type" => {
                            self.top_type = None;
                            self.pending_slot = TargetSlot::TopType;
                        }
                        "payload" => {
                            self.payload_cwd = None;
                            self.payload_source_has_subagent = false;
                            self.pending_object_role = ObjectRole::Payload;
                        }
                        _ => {}
                    },
                    ObjectRole::Payload => match self.buf.as_str() {
                        "cwd" => {
                            self.payload_cwd = None;
                            self.pending_slot = TargetSlot::PayloadCwd;
                        }
                        "source" => {
                            self.payload_source_has_subagent = false;
                            self.pending_object_role = ObjectRole::PayloadSource;
                        }
                        _ => {}
                    },
                    ObjectRole::PayloadSource => {
                        if self.buf == "subagent" || self.buf == "subAgent" {
                            self.payload_source_has_subagent = true;
                        }
                    }
                    ObjectRole::Ignore => {}
                }
                self.buf.clear();
                self.active_key_role = None;
                if let Some(Container::Object { expect, .. }) = self.stack.last_mut() {
                    *expect = ObjExpect::Colon;
                }
            }
            TargetSlot::TopCwd => {
                let val = std::mem::take(&mut self.buf);
                if self.source != ProviderSource::Pi
                    && self.early_cwd.is_none()
                    && !val.trim().is_empty()
                {
                    self.early_cwd = Some(val.clone());
                }
                self.top_cwd = Some(val);
                self.complete_value();
            }
            TargetSlot::TopType => {
                self.top_type = Some(std::mem::take(&mut self.buf));
                self.complete_value();
            }
            TargetSlot::PayloadCwd => {
                self.payload_cwd = Some(std::mem::take(&mut self.buf));
                self.complete_value();
            }
            TargetSlot::None => {
                self.complete_value();
            }
        }
    }

    fn feed(&mut self, data: &[u8]) {
        let mut i = 0;
        let len = data.len();
        while i < len && !self.malformed && !self.limit_exceeded && self.early_cwd.is_none() {
            match &mut self.token {
                TokenState::String { .. } => {
                    i = self.feed_string(data, i);
                }
                TokenState::Number { .. } => {
                    i = self.feed_number(data, i);
                }
                TokenState::Literal { expected, pos } => {
                    let b = data[i];
                    if b == expected[*pos] {
                        *pos += 1;
                        i += 1;
                        if *pos == expected.len() {
                            self.token = TokenState::Idle;
                            self.complete_value();
                        }
                    } else {
                        self.malformed = true;
                        return;
                    }
                }
                TokenState::Idle => {
                    while i < len && matches!(data[i], b' ' | b'\t' | b'\r' | b'\n') {
                        i += 1;
                    }
                    if i >= len {
                        break;
                    }
                    let b = data[i];
                    if self.root_complete {
                        self.malformed = true;
                        return;
                    }
                    if !self.root_started {
                        self.root_started = true;
                        i = self.start_value(b, i, ObjectRole::Root, TargetSlot::None);
                        continue;
                    }
                    let Some(top) = self.stack.last_mut() else {
                        self.malformed = true;
                        return;
                    };
                    match top {
                        Container::Object { expect, role } => {
                            let role_copy = *role;
                            match *expect {
                                ObjExpect::KeyOrEnd => {
                                    if b == b'}' {
                                        self.stack.pop();
                                        self.complete_value();
                                        i += 1;
                                    } else if b == b'"' {
                                        let capture = role_copy != ObjectRole::Ignore;
                                        self.active_key_role = Some(role_copy);
                                        self.buf.clear();
                                        self.token = TokenState::String {
                                            capture,
                                            slot: TargetSlot::Key,
                                            escaped: false,
                                            unicode_rem: 0,
                                            unicode_acc: 0,
                                            high_surrogate: None,
                                            pending_backslash_after_surrogate: false,
                                            utf8_buf: [0; 4],
                                            utf8_len: 0,
                                        };
                                        i += 1;
                                    } else {
                                        self.malformed = true;
                                        return;
                                    }
                                }
                                ObjExpect::Key => {
                                    if b == b'"' {
                                        let capture = role_copy != ObjectRole::Ignore;
                                        self.active_key_role = Some(role_copy);
                                        self.buf.clear();
                                        self.token = TokenState::String {
                                            capture,
                                            slot: TargetSlot::Key,
                                            escaped: false,
                                            unicode_rem: 0,
                                            unicode_acc: 0,
                                            high_surrogate: None,
                                            pending_backslash_after_surrogate: false,
                                            utf8_buf: [0; 4],
                                            utf8_len: 0,
                                        };
                                        i += 1;
                                    } else {
                                        self.malformed = true;
                                        return;
                                    }
                                }
                                ObjExpect::Colon => {
                                    if b == b':' {
                                        *expect = ObjExpect::Value;
                                        i += 1;
                                    } else {
                                        self.malformed = true;
                                        return;
                                    }
                                }
                                ObjExpect::Value => {
                                    let slot = self.pending_slot;
                                    let next_role = self.pending_object_role;
                                    self.pending_slot = TargetSlot::None;
                                    self.pending_object_role = ObjectRole::Ignore;
                                    i = self.start_value(b, i, next_role, slot);
                                }
                                ObjExpect::CommaOrEnd => {
                                    if b == b',' {
                                        *expect = ObjExpect::Key;
                                        i += 1;
                                    } else if b == b'}' {
                                        self.stack.pop();
                                        self.complete_value();
                                        i += 1;
                                    } else {
                                        self.malformed = true;
                                        return;
                                    }
                                }
                            }
                        }
                        Container::Array { expect } => match *expect {
                            ArrExpect::ValueOrEnd => {
                                if b == b']' {
                                    self.stack.pop();
                                    self.complete_value();
                                    i += 1;
                                } else {
                                    i = self.start_value(
                                        b,
                                        i,
                                        ObjectRole::Ignore,
                                        TargetSlot::None,
                                    );
                                }
                            }
                            ArrExpect::Value => {
                                i = self.start_value(b, i, ObjectRole::Ignore, TargetSlot::None);
                            }
                            ArrExpect::CommaOrEnd => {
                                if b == b',' {
                                    *expect = ArrExpect::Value;
                                    i += 1;
                                } else if b == b']' {
                                    self.stack.pop();
                                    self.complete_value();
                                    i += 1;
                                } else {
                                    self.malformed = true;
                                    return;
                                }
                            }
                        },
                    }
                }
            }
        }
    }

    fn start_value(&mut self, b: u8, i: usize, role: ObjectRole, slot: TargetSlot) -> usize {
        match b {
            b'{' => {
                if self.stack.len() >= MAX_JSON_DEPTH {
                    self.limit_exceeded = true;
                    return i + 1;
                }
                self.stack.push(Container::Object {
                    expect: ObjExpect::KeyOrEnd,
                    role,
                });
                i + 1
            }
            b'[' => {
                if self.stack.len() >= MAX_JSON_DEPTH {
                    self.limit_exceeded = true;
                    return i + 1;
                }
                self.stack.push(Container::Array {
                    expect: ArrExpect::ValueOrEnd,
                });
                i + 1
            }
            b'"' => {
                let capture = slot != TargetSlot::None;
                if capture {
                    self.buf.clear();
                }
                self.token = TokenState::String {
                    capture,
                    slot,
                    escaped: false,
                    unicode_rem: 0,
                    unicode_acc: 0,
                    high_surrogate: None,
                    pending_backslash_after_surrogate: false,
                    utf8_buf: [0; 4],
                    utf8_len: 0,
                };
                i + 1
            }
            b'-' => {
                self.token = TokenState::Number {
                    stage: NumStage::AfterMinus,
                };
                i + 1
            }
            b'0' => {
                self.token = TokenState::Number {
                    stage: NumStage::AfterZero,
                };
                i + 1
            }
            b'1'..=b'9' => {
                self.token = TokenState::Number {
                    stage: NumStage::IntDigits,
                };
                i + 1
            }
            b't' => {
                self.token = TokenState::Literal {
                    expected: b"rue",
                    pos: 0,
                };
                i + 1
            }
            b'f' => {
                self.token = TokenState::Literal {
                    expected: b"alse",
                    pos: 0,
                };
                i + 1
            }
            b'n' => {
                self.token = TokenState::Literal {
                    expected: b"ull",
                    pos: 0,
                };
                i + 1
            }
            _ => {
                self.malformed = true;
                i + 1
            }
        }
    }

    fn feed_string(&mut self, data: &[u8], mut i: usize) -> usize {
        let TokenState::String {
            capture,
            slot,
            mut escaped,
            mut unicode_rem,
            mut unicode_acc,
            mut high_surrogate,
            mut pending_backslash_after_surrogate,
            mut utf8_buf,
            mut utf8_len,
        } = std::mem::replace(&mut self.token, TokenState::Idle)
        else {
            unreachable!()
        };

        let len = data.len();
        while i < len {
            if unicode_rem > 0 {
                let Some(nibble) = hex_val(data[i]) else {
                    self.malformed = true;
                    return i;
                };
                unicode_acc = (unicode_acc << 4) | nibble;
                unicode_rem -= 1;
                i += 1;
                if unicode_rem == 0 && capture {
                    if let Some(hi) = high_surrogate.take() {
                        if (0xDC00..=0xDFFF).contains(&unicode_acc) {
                            let combined = 0x10000
                                + (((hi as u32 - 0xD800) << 10) | (unicode_acc as u32 - 0xDC00));
                            let ch = char::from_u32(combined).unwrap_or('\u{FFFD}');
                            if !self.push_captured_char(ch) {
                                return i;
                            }
                        } else {
                            if !self.push_captured_char('\u{FFFD}') {
                                return i;
                            }
                            if (0xD800..=0xDBFF).contains(&unicode_acc) {
                                high_surrogate = Some(unicode_acc);
                            } else {
                                let ch = char::from_u32(unicode_acc as u32).unwrap_or('\u{FFFD}');
                                if !self.push_captured_char(ch) {
                                    return i;
                                }
                            }
                        }
                    } else if (0xD800..=0xDBFF).contains(&unicode_acc) {
                        high_surrogate = Some(unicode_acc);
                    } else {
                        let ch = char::from_u32(unicode_acc as u32).unwrap_or('\u{FFFD}');
                        if !self.push_captured_char(ch) {
                            return i;
                        }
                    }
                }
                continue;
            }

            if pending_backslash_after_surrogate {
                pending_backslash_after_surrogate = false;
                let esc = data[i];
                i += 1;
                if esc == b'u' {
                    unicode_rem = 4;
                    unicode_acc = 0;
                    continue;
                }
                if high_surrogate.take().is_some()
                    && capture
                    && !self.push_captured_char('\u{FFFD}')
                {
                    return i;
                }
                if !self.apply_simple_escape(esc, capture) {
                    return i;
                }
                continue;
            }

            if escaped {
                escaped = false;
                let esc = data[i];
                i += 1;
                if esc == b'u' {
                    unicode_rem = 4;
                    unicode_acc = 0;
                    continue;
                }
                if !self.apply_simple_escape(esc, capture) {
                    return i;
                }
                continue;
            }

            if high_surrogate.is_some() {
                if data[i] == b'\\' {
                    pending_backslash_after_surrogate = true;
                    i += 1;
                    continue;
                }
                high_surrogate = None;
                if capture && !self.push_captured_char('\u{FFFD}') {
                    return i;
                }
            }

            let slice = &data[i..len];
            match memchr2(b'"', b'\\', slice) {
                Some(rel) => {
                    let span = &slice[..rel];
                    if span.iter().any(|&b| b < 0x20) {
                        self.malformed = true;
                        return i;
                    }
                    let delim = slice[rel];
                    if capture
                        && !self.push_captured_bytes(span, &mut utf8_buf, &mut utf8_len, true)
                    {
                        return i + rel;
                    }
                    i += rel + 1;
                    if delim == b'"' {
                        self.finish_string(slot);
                        return i;
                    }
                    escaped = true;
                }
                None => {
                    if slice.iter().any(|&b| b < 0x20) {
                        self.malformed = true;
                        return i;
                    }
                    if capture
                        && !self.push_captured_bytes(slice, &mut utf8_buf, &mut utf8_len, false)
                    {
                        return len;
                    }
                    i = len;
                }
            }
        }

        self.token = TokenState::String {
            capture,
            slot,
            escaped,
            unicode_rem,
            unicode_acc,
            high_surrogate,
            pending_backslash_after_surrogate,
            utf8_buf,
            utf8_len,
        };
        i
    }

    fn apply_simple_escape(&mut self, esc: u8, capture: bool) -> bool {
        let decoded = match esc {
            b'"' => '"',
            b'\\' => '\\',
            b'/' => '/',
            b'b' => '\u{0008}',
            b'f' => '\u{000C}',
            b'n' => '\n',
            b'r' => '\r',
            b't' => '\t',
            _ => {
                self.malformed = true;
                return false;
            }
        };
        if capture {
            return self.push_captured_char(decoded);
        }
        true
    }

    fn feed_number(&mut self, data: &[u8], mut i: usize) -> usize {
        let TokenState::Number { mut stage } =
            std::mem::replace(&mut self.token, TokenState::Idle)
        else {
            unreachable!()
        };

        let len = data.len();
        while i < len {
            let b = data[i];
            match stage {
                NumStage::AfterMinus => match b {
                    b'0' => {
                        stage = NumStage::AfterZero;
                        i += 1;
                    }
                    b'1'..=b'9' => {
                        stage = NumStage::IntDigits;
                        i += 1;
                    }
                    _ => {
                        self.malformed = true;
                        return i;
                    }
                },
                NumStage::AfterZero => match b {
                    b'.' => {
                        stage = NumStage::FracStart;
                        i += 1;
                    }
                    b'e' | b'E' => {
                        stage = NumStage::ExpSignOrDigit;
                        i += 1;
                    }
                    b'0'..=b'9' => {
                        self.malformed = true;
                        return i;
                    }
                    _ => {
                        self.complete_value();
                        return i;
                    }
                },
                NumStage::IntDigits => match b {
                    b'0'..=b'9' => {
                        i += 1;
                    }
                    b'.' => {
                        stage = NumStage::FracStart;
                        i += 1;
                    }
                    b'e' | b'E' => {
                        stage = NumStage::ExpSignOrDigit;
                        i += 1;
                    }
                    _ => {
                        self.complete_value();
                        return i;
                    }
                },
                NumStage::FracStart => match b {
                    b'0'..=b'9' => {
                        stage = NumStage::FracDigits;
                        i += 1;
                    }
                    _ => {
                        self.malformed = true;
                        return i;
                    }
                },
                NumStage::FracDigits => match b {
                    b'0'..=b'9' => {
                        i += 1;
                    }
                    b'e' | b'E' => {
                        stage = NumStage::ExpSignOrDigit;
                        i += 1;
                    }
                    _ => {
                        self.complete_value();
                        return i;
                    }
                },
                NumStage::ExpSignOrDigit => match b {
                    b'+' | b'-' => {
                        stage = NumStage::ExpStart;
                        i += 1;
                    }
                    b'0'..=b'9' => {
                        stage = NumStage::ExpDigits;
                        i += 1;
                    }
                    _ => {
                        self.malformed = true;
                        return i;
                    }
                },
                NumStage::ExpStart => match b {
                    b'0'..=b'9' => {
                        stage = NumStage::ExpDigits;
                        i += 1;
                    }
                    _ => {
                        self.malformed = true;
                        return i;
                    }
                },
                NumStage::ExpDigits => match b {
                    b'0'..=b'9' => {
                        i += 1;
                    }
                    _ => {
                        self.complete_value();
                        return i;
                    }
                },
            }
        }

        self.token = TokenState::Number { stage };
        i
    }

    fn finish_line(&mut self) -> Result<CwdOutcome, ()> {
        if self.limit_exceeded {
            return Err(());
        }
        if !self.malformed {
            if let TokenState::Number { stage } = self.token {
                match stage {
                    NumStage::AfterZero
                    | NumStage::IntDigits
                    | NumStage::FracDigits
                    | NumStage::ExpDigits => {
                        self.token = TokenState::Idle;
                        self.complete_value();
                    }
                    _ => {
                        self.malformed = true;
                    }
                }
            } else if !matches!(self.token, TokenState::Idle) {
                self.malformed = true;
            }
        }

        let outcome = if self.malformed || !self.root_complete {
            CwdOutcome::NotFound
        } else {
            match self.source {
                ProviderSource::Pi => {
                    if self.top_type.as_deref() == Some("session")
                        && let Some(cwd) = self.top_cwd.as_deref()
                    {
                        let trimmed = cwd.trim();
                        if !trimmed.is_empty() {
                            CwdOutcome::Found(trimmed.to_string())
                        } else {
                            CwdOutcome::NotFound
                        }
                    } else {
                        CwdOutcome::NotFound
                    }
                }
                ProviderSource::ClaudeAgent | ProviderSource::Codex => {
                    if let Some(cwd) = &self.top_cwd
                        && !cwd.trim().is_empty()
                    {
                        CwdOutcome::Found(cwd.clone())
                    } else if self.source == ProviderSource::Codex
                        && self.top_type.as_deref() == Some("session_meta")
                        && self.payload_source_has_subagent
                    {
                        CwdOutcome::Excluded
                    } else if let Some(cwd) = &self.payload_cwd
                        && !cwd.trim().is_empty()
                    {
                        CwdOutcome::Found(cwd.clone())
                    } else {
                        CwdOutcome::NotFound
                    }
                }
            }
        };

        self.reset();
        Ok(outcome)
    }
}

#[inline]
fn hex_val(byte: u8) -> Option<u16> {
    match byte {
        b'0'..=b'9' => Some((byte - b'0') as u16),
        b'a'..=b'f' => Some((byte - b'a' + 10) as u16),
        b'A'..=b'F' => Some((byte - b'A' + 10) as u16),
        _ => None,
    }
}

fn read_exact_or_eof<R: Read>(reader: &mut R, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        }
    }
    Ok(filled)
}

fn scan_transcript_cwd(
    transcript: &DiscoveredTranscript,
    source: ProviderSource,
    limits: &SourceLimits,
    bytes_budget: u64,
    ops_budget: usize,
    records_budget: usize,
) -> CwdScanMetrics {
    if transcript.size == 0 {
        return CwdScanMetrics {
            outcome: CwdOutcome::NotFound,
            bytes_charged: 0,
            operations_used: 0,
            records_used: 0,
            truncated: false,
        };
    }
    if bytes_budget == 0 || ops_budget < 2 || records_budget == 0 {
        return CwdScanMetrics {
            outcome: CwdOutcome::NotFound,
            bytes_charged: 0,
            operations_used: 0,
            records_used: 0,
            truncated: true,
        };
    }

    let mut ops_used: usize = 1;
    let mut bytes_charged: u64 = 0;
    let mut records_used: usize = 0;
    let mut truncated = false;

    let path = Path::new(&transcript.file_path);
    let Ok(meta) = fs::metadata(path) else {
        return CwdScanMetrics {
            outcome: CwdOutcome::NotFound,
            bytes_charged: 0,
            operations_used: ops_used,
            records_used: 0,
            truncated: false,
        };
    };
    if !meta.is_file() {
        return CwdScanMetrics {
            outcome: CwdOutcome::NotFound,
            bytes_charged: 0,
            operations_used: ops_used,
            records_used: 0,
            truncated: false,
        };
    }
    let Ok(file) = File::open(path) else {
        return CwdScanMetrics {
            outcome: CwdOutcome::NotFound,
            bytes_charged: 0,
            operations_used: ops_used,
            records_used: 0,
            truncated: false,
        };
    };
    if !file.metadata().map(|m| m.is_file()).unwrap_or(false) {
        return CwdScanMetrics {
            outcome: CwdOutcome::NotFound,
            bytes_charged: 0,
            operations_used: ops_used,
            records_used: 0,
            truncated: false,
        };
    }

    let compressed = is_compressed_transcript(&transcript.file_path);
    let max_scan_bytes = limits.max_transcript_scan_bytes.max(1) as u64;
    let chunk_size = limits.metadata_read_chunk_bytes.max(1);
    let effective_size = if compressed { u64::MAX } else { transcript.size };
    let max_bytes = max_scan_bytes.min(effective_size);

    let mut reader: Box<dyn Read> = if compressed {
        match zstd::stream::read::Decoder::new(file) {
            Ok(dec) => Box::new(dec),
            Err(_) => {
                return CwdScanMetrics {
                    outcome: CwdOutcome::NotFound,
                    bytes_charged: 0,
                    operations_used: ops_used,
                    records_used: 0,
                    truncated: false,
                };
            }
        }
    } else {
        Box::new(file)
    };

    let mut parser = CwdLineParser::new(source, limits.max_transcript_scan_bytes.max(1));
    let mut chunk = vec![0u8; chunk_size];
    let mut bytes_read: u64 = 0;
    let mut record_started = false;
    let mut hit_eof = false;

    while bytes_read < max_bytes {
        let bytes_rem = bytes_budget.saturating_sub(bytes_charged);
        let ops_rem = ops_budget.saturating_sub(ops_used);
        if bytes_rem == 0 || ops_rem == 0 {
            truncated = true;
            return CwdScanMetrics {
                outcome: CwdOutcome::NotFound,
                bytes_charged,
                operations_used: ops_used,
                records_used,
                truncated,
            };
        }
        let read_size = (chunk_size as u64)
            .min(max_bytes - bytes_read)
            .min(bytes_rem) as usize;
        ops_used += 1;
        bytes_charged += read_size as u64;

        let n = match read_exact_or_eof(&mut reader, &mut chunk[..read_size]) {
            Ok(0) => {
                hit_eof = true;
                break;
            }
            Ok(n) => n,
            Err(_) => {
                return CwdScanMetrics {
                    outcome: CwdOutcome::NotFound,
                    bytes_charged,
                    operations_used: ops_used,
                    records_used,
                    truncated: false,
                };
            }
        };
        bytes_read += n as u64;

        let mut start = 0;
        while start < n {
            let slice = &chunk[start..n];
            match memchr(b'\n', slice) {
                Some(rel) => {
                    let end = start + rel;
                    if end > start {
                        parser.feed(&chunk[start..end]);
                        if parser.limit_exceeded {
                            return CwdScanMetrics {
                                outcome: CwdOutcome::NotFound,
                                bytes_charged,
                                operations_used: ops_used,
                                records_used,
                                truncated: false,
                            };
                        }
                        if let Some(early) = parser.early_cwd.take() {
                            if records_used >= limits.max_metadata_records_per_transcript
                                || records_used >= records_budget
                            {
                                return CwdScanMetrics {
                                    outcome: CwdOutcome::NotFound,
                                    bytes_charged,
                                    operations_used: ops_used,
                                    records_used,
                                    truncated: true,
                                };
                            }
                            records_used += 1;
                            return CwdScanMetrics {
                                outcome: CwdOutcome::Found(early),
                                bytes_charged,
                                operations_used: ops_used,
                                records_used,
                                truncated: false,
                            };
                        }
                    }
                    if records_used >= limits.max_metadata_records_per_transcript
                        || records_used >= records_budget
                    {
                        return CwdScanMetrics {
                            outcome: CwdOutcome::NotFound,
                            bytes_charged,
                            operations_used: ops_used,
                            records_used,
                            truncated: true,
                        };
                    }
                    records_used += 1;
                    record_started = false;
                    match parser.finish_line() {
                        Ok(CwdOutcome::NotFound) => {}
                        Ok(outcome) => {
                            return CwdScanMetrics {
                                outcome,
                                bytes_charged,
                                operations_used: ops_used,
                                records_used,
                                truncated: false,
                            };
                        }
                        Err(()) => {
                            return CwdScanMetrics {
                                outcome: CwdOutcome::NotFound,
                                bytes_charged,
                                operations_used: ops_used,
                                records_used,
                                truncated: false,
                            };
                        }
                    }
                    start = end + 1;
                }
                None => {
                    if n > start {
                        record_started = true;
                        parser.feed(&chunk[start..n]);
                        if parser.limit_exceeded {
                            return CwdScanMetrics {
                                outcome: CwdOutcome::NotFound,
                                bytes_charged,
                                operations_used: ops_used,
                                records_used,
                                truncated: false,
                            };
                        }
                        if let Some(early) = parser.early_cwd.take() {
                            if records_used >= limits.max_metadata_records_per_transcript
                                || records_used >= records_budget
                            {
                                return CwdScanMetrics {
                                    outcome: CwdOutcome::NotFound,
                                    bytes_charged,
                                    operations_used: ops_used,
                                    records_used,
                                    truncated: true,
                                };
                            }
                            records_used += 1;
                            return CwdScanMetrics {
                                outcome: CwdOutcome::Found(early),
                                bytes_charged,
                                operations_used: ops_used,
                                records_used,
                                truncated: false,
                            };
                        }
                    }
                    break;
                }
            }
        }
        if n < read_size {
            hit_eof = true;
            break;
        }
    }

    if !hit_eof {
        let reached_end = if compressed {
            let mut probe = [0u8; 1];
            matches!(read_exact_or_eof(&mut reader, &mut probe), Ok(0))
        } else {
            bytes_read >= effective_size
        };
        if !reached_end {
            return CwdScanMetrics {
                outcome: CwdOutcome::NotFound,
                bytes_charged,
                operations_used: ops_used,
                records_used,
                truncated: true,
            };
        }
    }

    if !record_started {
        return CwdScanMetrics {
            outcome: CwdOutcome::NotFound,
            bytes_charged,
            operations_used: ops_used,
            records_used,
            truncated,
        };
    }

    if records_used >= limits.max_metadata_records_per_transcript || records_used >= records_budget
    {
        return CwdScanMetrics {
            outcome: CwdOutcome::NotFound,
            bytes_charged,
            operations_used: ops_used,
            records_used,
            truncated: true,
        };
    }
    records_used += 1;
    let outcome = parser.finish_line().unwrap_or(CwdOutcome::NotFound);
    CwdScanMetrics {
        outcome,
        bytes_charged,
        operations_used: ops_used,
        records_used,
        truncated,
    }
}

fn hint_matches_transcript(hint: &CachedHint, t: &DiscoveredTranscript) -> bool {
    hint.file_path == t.file_path
        && hint.provider_instance_id == t.provider_instance_id
        && hint.size == t.size
        && hint.mtime_ms == Some(t.mtime_ms)
        && hint.device == t.device
        && hint.inode == t.inode
        && hint.birthtime_ms == t.birthtime_ms
}

fn scan_provider_source(req: &SourceScanRequest, max_threads: usize) -> SourceScanResult {
    let limits = &req.limits;
    let mut truncated = false;

    let shares = split_operation_budget(limits.max_discovery_operations, req.homes.len());
    let mut discovered: Vec<HomeDiscoveryResult> = req
        .homes
        .iter()
        .enumerate()
        .map(|(idx, home)| discover_home(req.source, home, shares[idx], max_threads))
        .collect();

    let total_used: usize = discovered.iter().map(|r| r.operations_used).sum();
    let mut unused = limits.max_discovery_operations.saturating_sub(total_used);
    let mut starved: Vec<usize> = discovered
        .iter()
        .enumerate()
        .filter_map(|(idx, r)| r.truncated.then_some(idx))
        .collect();

    while unused > 0 && !starved.is_empty() {
        let count = starved.len();
        for (pos, &idx) in starved.iter().enumerate() {
            if unused == 0 {
                break;
            }
            let before = discovered[idx].operations_used;
            let remaining_starved = count - pos;
            let extra = unused.div_ceil(remaining_starved);
            let res = discover_home(req.source, &req.homes[idx], before + extra, max_threads);
            let delta = res.operations_used.saturating_sub(before);
            discovered[idx] = res;
            unused = unused.saturating_sub(delta);
        }
        starved.retain(|&idx| discovered[idx].truncated);
    }

    let mut all_transcripts: Vec<DiscoveredTranscript> = Vec::new();
    for res in discovered {
        truncated |= res.truncated;
        all_transcripts.extend(res.transcripts);
    }

    all_transcripts.sort_by(|left, right| {
        right
            .mtime_ms
            .cmp(&left.mtime_ms)
            .then_with(|| left.file_path.cmp(&right.file_path))
    });
    if all_transcripts.len() > limits.max_transcripts {
        truncated = true;
    }

    let selected = select_metadata_transcripts(all_transcripts, limits.max_transcripts);

    let mut hints_by_key: HashMap<(&str, &str), Vec<&CachedHint>> = HashMap::new();
    if req.source != ProviderSource::Codex {
        for hint in &req.cached_hints {
            hints_by_key
                .entry((hint.provider_instance_id.as_str(), hint.file_path.as_str()))
                .or_default()
                .push(hint);
        }
    }

    let mut bytes_remaining = limits.max_metadata_bytes;
    let mut ops_remaining = limits.max_metadata_operations;
    let mut records_remaining = limits.max_metadata_records;
    let mut metadata_truncated = false;
    let mut out_transcripts: Vec<ScannedTranscript> = Vec::with_capacity(selected.len());

    // Wave-based parallelism preserves exact sequential metadata budget commitment order.
    let wave_size = (max_threads * 4).clamp(1, 64);
    let mut cursor = 0;
    while cursor < selected.len() {
        let wave_end = (cursor + wave_size).min(selected.len());
        let wave = &selected[cursor..wave_end];

        let mut cached_cwds: Vec<Option<String>> = Vec::with_capacity(wave.len());
        let mut to_scan_indices: Vec<usize> = Vec::new();
        for (offset, t) in wave.iter().enumerate() {
            let cached = if req.source == ProviderSource::Codex {
                None
            } else {
                hints_by_key
                    .get(&(t.provider_instance_id.as_str(), t.file_path.as_str()))
                    .and_then(|list| list.iter().find(|h| hint_matches_transcript(h, t)))
                    .map(|h| h.cwd.clone())
            };
            if cached.is_none() && t.size > 0 {
                to_scan_indices.push(offset);
            }
            cached_cwds.push(cached);
        }

        let mut scanned_map: Vec<Option<CwdScanMetrics>> = vec![None; wave.len()];
        if !to_scan_indices.is_empty() && bytes_remaining > 0 && ops_remaining >= 2 && records_remaining > 0 {
            let worker_count = max_threads.min(to_scan_indices.len());
            if worker_count <= 1 || to_scan_indices.len() < 4 {
                for &offset in &to_scan_indices {
                    scanned_map[offset] = Some(scan_transcript_cwd(
                        &wave[offset],
                        req.source,
                        limits,
                        limits.max_metadata_bytes,
                        limits.max_metadata_operations,
                        limits.max_metadata_records,
                    ));
                }
            } else {
                let next_idx = AtomicUsize::new(0);
                let slots: Vec<std::sync::Mutex<Option<CwdScanMetrics>>> = (0..to_scan_indices.len())
                    .map(|_| std::sync::Mutex::new(None))
                    .collect();
                thread::scope(|scope| {
                    for _ in 0..worker_count {
                        scope.spawn(|| {
                            loop {
                                let pos = next_idx.fetch_add(1, Ordering::Relaxed);
                                if pos >= to_scan_indices.len() {
                                    break;
                                }
                                let offset = to_scan_indices[pos];
                                let res = scan_transcript_cwd(
                                    &wave[offset],
                                    req.source,
                                    limits,
                                    limits.max_metadata_bytes,
                                    limits.max_metadata_operations,
                                    limits.max_metadata_records,
                                );
                                *slots[pos].lock().unwrap() = Some(res);
                            }
                        });
                    }
                });
                for (pos, slot) in slots.into_iter().enumerate() {
                    scanned_map[to_scan_indices[pos]] = slot.into_inner().unwrap();
                }
            }
        }

        for (offset, t) in wave.iter().enumerate() {
            if let Some(cwd) = cached_cwds[offset].take() {
                out_transcripts.push(ScannedTranscript {
                    file_path: t.file_path.clone(),
                    provider_instance_id: t.provider_instance_id.clone(),
                    home_path: t.home_path.clone(),
                    mtime_ms: t.mtime_ms,
                    size: t.size,
                    device: t.device,
                    inode: t.inode.clone(),
                    birthtime_ms: t.birthtime_ms,
                    cwd,
                });
                continue;
            }
            if t.size == 0 {
                continue;
            }
            if bytes_remaining == 0 || ops_remaining < 2 || records_remaining == 0 {
                metadata_truncated = true;
                continue;
            }

            let metrics = match scanned_map[offset].take() {
                Some(m)
                    if m.bytes_charged <= bytes_remaining
                        && m.operations_used <= ops_remaining
                        && m.records_used <= records_remaining =>
                {
                    m
                }
                _ => scan_transcript_cwd(
                    t,
                    req.source,
                    limits,
                    bytes_remaining,
                    ops_remaining,
                    records_remaining,
                ),
            };

            bytes_remaining = bytes_remaining.saturating_sub(metrics.bytes_charged);
            ops_remaining = ops_remaining.saturating_sub(metrics.operations_used);
            records_remaining = records_remaining.saturating_sub(metrics.records_used);
            metadata_truncated |= metrics.truncated;

            if let CwdOutcome::Found(cwd) = metrics.outcome {
                out_transcripts.push(ScannedTranscript {
                    file_path: t.file_path.clone(),
                    provider_instance_id: t.provider_instance_id.clone(),
                    home_path: t.home_path.clone(),
                    mtime_ms: t.mtime_ms,
                    size: t.size,
                    device: t.device,
                    inode: t.inode.clone(),
                    birthtime_ms: t.birthtime_ms,
                    cwd,
                });
            }
        }

        cursor = wave_end;
    }

    SourceScanResult {
        source: req.source,
        truncated: truncated || metadata_truncated,
        metadata_truncated,
        transcripts: out_transcripts,
    }
}

/// Lexical equivalent of Node's `path.resolve(base, target)` without resolving symlinks.
pub fn resolve_lexical_path(base: &str, target: &str) -> String {
    let target_path = Path::new(target);
    let combined = if target_path.is_absolute() {
        target_path.to_path_buf()
    } else {
        Path::new(base).join(target_path)
    };
    let mut out = PathBuf::new();
    for comp in combined.components() {
        match comp {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(
                    out.components().next_back(),
                    None | Some(Component::RootDir | Component::Prefix(_))
                ) {
                    out.pop();
                }
            }
            Component::Normal(seg) => out.push(seg),
        }
    }
    out.to_string_lossy().into_owned()
}

fn is_linked_worktree_git_dir(git_dir: &str) -> bool {
    let trimmed = git_dir
        .strip_suffix('/')
        .or_else(|| git_dir.strip_suffix('\\'))
        .unwrap_or(git_dir);
    let Some(last_sep) = trimmed.rfind(['/', '\\']) else {
        return false;
    };
    let leaf = &trimmed[last_sep + 1..];
    if leaf.is_empty() {
        return false;
    }
    let before_leaf = &trimmed[..last_sep];
    let Some(prev_sep) = before_leaf.rfind(['/', '\\']) else {
        return false;
    };
    &before_leaf[prev_sep + 1..] == "worktrees"
}

fn parse_gitdir_pointer(text: &str) -> Option<&str> {
    for raw_line in text.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if let Some(rest) = line.strip_prefix("gitdir:")
            && !rest.is_empty()
        {
            let trimmed = rest.trim();
            return if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
        }
    }
    None
}

fn parse_head_branch(text: &str) -> Option<String> {
    let branch = text.trim().strip_prefix("ref: refs/heads/")?;
    if branch.is_empty() {
        None
    } else {
        Some(branch.to_string())
    }
}

fn git_config_lines(config_text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut pending = String::new();
    let mut quoted = false;

    for raw_line in config_text.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let mut continued = false;
        if line.ends_with('\\') || !pending.is_empty() {
            let mut chars = line.chars();
            while let Some(ch) = chars.next() {
                match ch {
                    '"' => quoted = !quoted,
                    '#' | ';' if !quoted => break,
                    '\\' => {
                        if chars.next().is_none() {
                            continued = true;
                        }
                    }
                    _ => {}
                }
            }
        }
        if continued {
            pending.push_str(&line[..line.len() - 1]);
            continue;
        }
        if !quoted {
            if pending.is_empty() {
                out.push(line.to_string());
            } else {
                let mut combined = std::mem::take(&mut pending);
                combined.push_str(line);
                out.push(combined);
            }
        }
        pending.clear();
        quoted = false;
    }
    if !pending.is_empty() && !quoted {
        out.push(pending);
    }
    out
}

fn parse_git_config_value(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut quoted = false;
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            } else {
                out.push('\\');
            }
            continue;
        }
        if ch == '"' {
            quoted = !quoted;
            continue;
        }
        if !quoted && (ch == '#' || ch == ';') {
            break;
        }
        out.push(ch);
    }
    out.trim().to_string()
}

fn is_true_git_config_value(value: &str) -> bool {
    if matches!(value, "true" | "yes" | "on") {
        return true;
    }
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut idx = 0;
    let neg = if bytes[idx] == b'-' {
        idx += 1;
        true
    } else if bytes[idx] == b'+' {
        idx += 1;
        false
    } else {
        false
    };
    if idx >= bytes.len() {
        return false;
    }
    let rest = &value[idx..];
    let (digits, scale): (&str, i128) = match rest.as_bytes().last() {
        Some(b'k') => (&rest[..rest.len() - 1], 1024),
        Some(b'm') => (&rest[..rest.len() - 1], 1024 * 1024),
        Some(b'g') => (&rest[..rest.len() - 1], 1024 * 1024 * 1024),
        _ => (rest, 1),
    };
    if digits.is_empty() {
        return false;
    }
    let magnitude = if let Some(hex) = digits.strip_prefix("0x") {
        if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return false;
        }
        i128::from_str_radix(hex, 16).ok()
    } else if digits.starts_with('0') {
        if !digits.bytes().all(|b| matches!(b, b'0'..=b'7')) {
            return false;
        }
        i128::from_str_radix(digits, 8).ok()
    } else {
        if !digits.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        digits.parse::<i128>().ok()
    };
    let Some(mag) = magnitude else {
        return false;
    };
    let Some(scaled) = mag.checked_mul(scale) else {
        return false;
    };
    let number = if neg { -scaled } else { scaled };
    number != 0 && number >= i32::MIN as i128 && number <= i32::MAX as i128
}

pub fn is_bare_git_config(config_text: &str) -> bool {
    let mut in_core = false;
    let mut bare = false;
    for raw_line in git_config_lines(config_text) {
        let mut line = raw_line.trim();
        if line.starts_with('[')
            && let Some(close) = line.find(']')
        {
            in_core = line[1..close].trim().eq_ignore_ascii_case("core");
            line = line[close + 1..].trim();
        }
        if !in_core {
            continue;
        }
        if line.len() < 4 || !line[..4].eq_ignore_ascii_case("bare") {
            continue;
        }
        let after = line[4..].trim_start();
        let value = if after.is_empty() || after.starts_with('#') || after.starts_with(';') {
            "true".to_string()
        } else if let Some(rhs) = after.strip_prefix('=') {
            parse_git_config_value(rhs).to_ascii_lowercase()
        } else {
            continue;
        };
        bare = is_true_git_config_value(&value);
    }
    bare
}

pub fn parse_origin_url_from_git_config(config_text: &str) -> Option<String> {
    let mut section: Option<String> = None;
    let mut origin_url: Option<String> = None;
    let mut first_remote_url: Option<String> = None;

    for raw_line in git_config_lines(config_text) {
        let mut line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') {
            if let Some(close) = line.find(']') {
                let inside = line[1..close].trim();
                let parsed_remote = parse_remote_section_header(inside);
                if let Some(remote_name) = parsed_remote {
                    section = Some(remote_name);
                    line = line[close + 1..].trim();
                } else {
                    section = None;
                    continue;
                }
            } else {
                section = None;
                continue;
            }
        }
        let Some(sec) = section.as_deref() else {
            continue;
        };
        if line.len() < 3 || !line[..3].eq_ignore_ascii_case("url") {
            continue;
        }
        let after = line[3..].trim_start();
        let Some(rhs) = after.strip_prefix('=') else {
            continue;
        };
        let url = parse_git_config_value(rhs.trim_start());
        if url.is_empty() {
            continue;
        }
        if sec == "origin" {
            if origin_url.is_none() {
                origin_url = Some(url);
            }
        } else if first_remote_url.is_none() {
            first_remote_url = Some(url);
        }
    }

    origin_url.or(first_remote_url)
}

fn parse_remote_section_header(inside: &str) -> Option<String> {
    if inside.len() < 6 || !inside[..6].eq_ignore_ascii_case("remote") {
        return None;
    }
    let after = &inside[6..];
    if let Some(rest) = after.strip_prefix('.') {
        if !rest.is_empty() && !rest.chars().any(char::is_whitespace) {
            return Some(rest.to_ascii_lowercase());
        }
        return None;
    }
    let trimmed = after.trim_start();
    if trimmed.len() == after.len() {
        return None;
    }
    let inner = trimmed.strip_prefix('"')?.strip_suffix('"')?;
    if inner.is_empty() || inner.contains('"') {
        return None;
    }
    Some(inner.to_string())
}

enum GitPathProbe {
    NotGit,
    Directory,
    PointerText(String),
}

fn read_regular_file_bounded(path: &Path, max_bytes: usize) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let file = File::open(path).ok()?;
    if !file.metadata().map(|m| m.is_file()).unwrap_or(false) {
        return None;
    }
    let mut buf = Vec::new();
    let _ = file.take(max_bytes as u64).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Runs `work_fn` over `items` on detached bounded worker threads so a stuck kernel `open()`
/// or `stat()` on a cloud mount / macOS TCC-protected path never blocks process exit.
fn run_bounded_parallel<T, F>(
    paths: &[String],
    deadline_ms: u64,
    max_threads: usize,
    work_fn: F,
) -> (Vec<Option<T>>, Vec<String>)
where
    T: Send + 'static,
    F: Fn(&str) -> T + Send + Sync + 'static,
{
    if paths.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let total = paths.len();
    let shared_paths = Arc::new(paths.to_vec());
    let next_idx = Arc::new(AtomicUsize::new(0));
    let work_fn = Arc::new(work_fn);
    let (tx, rx) = mpsc::channel::<(usize, T)>();
    let worker_count = max_threads.min(total).max(1);

    for _ in 0..worker_count {
        let shared_paths = Arc::clone(&shared_paths);
        let next_idx = Arc::clone(&next_idx);
        let work_fn = Arc::clone(&work_fn);
        let tx = tx.clone();
        let _ = thread::Builder::new().spawn(move || {
            loop {
                let idx = next_idx.fetch_add(1, Ordering::Relaxed);
                if idx >= shared_paths.len() {
                    break;
                }
                let result = work_fn(&shared_paths[idx]);
                if tx.send((idx, result)).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    let mut slots: Vec<Option<T>> = (0..total).map(|_| None).collect();
    let deadline = Instant::now() + Duration::from_millis(deadline_ms);
    let mut remaining = total;
    while remaining > 0 {
        let Some(wait) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        match rx.recv_timeout(wait) {
            Ok((idx, value)) => {
                if slots[idx].is_none() {
                    slots[idx] = Some(value);
                    remaining -= 1;
                }
            }
            Err(_) => break,
        }
    }

    let mut timed_out = Vec::new();
    for (idx, slot) in slots.iter().enumerate() {
        if slot.is_none() {
            timed_out.push(paths[idx].clone());
        }
    }
    (slots, timed_out)
}

fn read_git_files_bounded(
    file_paths: &[String],
    blocked: &HashSet<String>,
    deadline_ms: u64,
    max_bytes: usize,
    max_threads: usize,
    timed_out_acc: &mut Vec<String>,
) -> HashMap<String, String> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for p in file_paths {
        if !blocked.contains(p) && seen.insert(p.clone()) {
            unique.push(p.clone());
        }
    }
    if unique.is_empty() {
        return HashMap::new();
    }

    let (slots, timed_out) = run_bounded_parallel(&unique, deadline_ms, max_threads, move |p| {
        read_regular_file_bounded(Path::new(p), max_bytes).unwrap_or_default()
    });
    timed_out_acc.extend(timed_out);

    let mut out = HashMap::with_capacity(unique.len());
    for (path, slot) in unique.into_iter().zip(slots) {
        out.insert(path, slot.unwrap_or_default());
    }
    out
}

fn resolve_git_identities(
    directories: &[String],
    blocked: &HashSet<String>,
    deadline_ms: u64,
    max_git_file_bytes: usize,
    max_threads: usize,
    timed_out_acc: &mut Vec<String>,
) -> Vec<GitDirectoryIdentity> {
    let mut unique_dirs = Vec::new();
    let mut seen_dirs = HashSet::new();
    for d in directories {
        if seen_dirs.insert(d.clone()) {
            unique_dirs.push(d.clone());
        }
    }
    if unique_dirs.is_empty() {
        return Vec::new();
    }

    let git_paths: Vec<String> = unique_dirs
        .iter()
        .map(|d| Path::new(d).join(".git").to_string_lossy().into_owned())
        .collect();
    let blocked_arc = Arc::new(blocked.clone());
    let (probes, timed_out_p1) =
        run_bounded_parallel(&git_paths, deadline_ms, max_threads, move |git_path| {
            if blocked_arc.contains(git_path) {
                return GitPathProbe::NotGit;
            }
            let p = Path::new(git_path);
            let Ok(meta) = fs::metadata(p) else {
                return GitPathProbe::NotGit;
            };
            if meta.is_dir() {
                return GitPathProbe::Directory;
            }
            if !meta.is_file() {
                return GitPathProbe::NotGit;
            }
            let text = read_regular_file_bounded(p, max_git_file_bytes).unwrap_or_default();
            GitPathProbe::PointerText(text)
        });
    timed_out_acc.extend(timed_out_p1);

    struct RepoEntry {
        directory: String,
        git_dir: String,
        worktree_git_dir: Option<String>,
    }
    struct LinkedWorktree {
        directory: String,
        git_dir: String,
    }

    let mut identity_map: HashMap<String, GitDirectoryIdentity> =
        HashMap::with_capacity(unique_dirs.len());
    let mut repositories: Vec<RepoEntry> = Vec::new();
    let mut linked_worktrees: Vec<LinkedWorktree> = Vec::new();

    for ((directory, git_path), probe) in unique_dirs.iter().zip(git_paths.iter()).zip(probes) {
        match probe {
            Some(GitPathProbe::Directory) => {
                repositories.push(RepoEntry {
                    directory: directory.clone(),
                    git_dir: git_path.clone(),
                    worktree_git_dir: None,
                });
            }
            Some(GitPathProbe::PointerText(text)) => {
                let Some(target) = parse_gitdir_pointer(&text) else {
                    identity_map.insert(
                        directory.clone(),
                        GitDirectoryIdentity {
                            directory: directory.clone(),
                            kind: GitIdentityKind::NotGit,
                            git_dir: None,
                            main_checkout: None,
                            origin_url: None,
                            is_bare: false,
                            config_present: false,
                            has_git: false,
                            head_branch: None,
                        },
                    );
                    continue;
                };
                let resolved_git_dir = resolve_lexical_path(directory, target);
                if is_linked_worktree_git_dir(&resolved_git_dir) {
                    linked_worktrees.push(LinkedWorktree {
                        directory: directory.clone(),
                        git_dir: resolved_git_dir,
                    });
                } else {
                    repositories.push(RepoEntry {
                        directory: directory.clone(),
                        git_dir: resolved_git_dir,
                        worktree_git_dir: None,
                    });
                }
            }
            Some(GitPathProbe::NotGit) | None => {
                identity_map.insert(
                    directory.clone(),
                    GitDirectoryIdentity {
                        directory: directory.clone(),
                        kind: GitIdentityKind::NotGit,
                        git_dir: None,
                        main_checkout: None,
                        origin_url: None,
                        is_bare: false,
                        config_present: false,
                        has_git: false,
                        head_branch: None,
                    },
                );
            }
        }
    }

    if !linked_worktrees.is_empty() {
        let commondir_paths: Vec<String> = linked_worktrees
            .iter()
            .map(|wt| {
                Path::new(&wt.git_dir)
                    .join("commondir")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        let commondir_texts = read_git_files_bounded(
            &commondir_paths,
            blocked,
            deadline_ms,
            max_git_file_bytes,
            max_threads,
            timed_out_acc,
        );
        for (wt, commondir_path) in linked_worktrees.into_iter().zip(commondir_paths) {
            let common_dir = commondir_texts
                .get(&commondir_path)
                .map(|s| s.trim())
                .unwrap_or("");
            if common_dir.is_empty() {
                identity_map.insert(
                    wt.directory.clone(),
                    GitDirectoryIdentity {
                        directory: wt.directory,
                        kind: GitIdentityKind::Worktree,
                        git_dir: Some(wt.git_dir),
                        main_checkout: None,
                        origin_url: None,
                        is_bare: false,
                        config_present: false,
                        has_git: false,
                        head_branch: None,
                    },
                );
            } else {
                repositories.push(RepoEntry {
                    directory: wt.directory,
                    git_dir: resolve_lexical_path(&wt.git_dir, common_dir),
                    worktree_git_dir: Some(wt.git_dir),
                });
            }
        }
    }

    if !repositories.is_empty() {
        let mut phase3_paths: Vec<String> = Vec::with_capacity(repositories.len() * 2);
        let config_paths: Vec<String> = repositories
            .iter()
            .map(|repo| {
                let p = Path::new(&repo.git_dir)
                    .join("config")
                    .to_string_lossy()
                    .into_owned();
                phase3_paths.push(p.clone());
                p
            })
            .collect();
        let head_paths: Vec<Option<String>> = repositories
            .iter()
            .map(|repo| {
                repo.worktree_git_dir.as_ref().map(|wt_dir| {
                    let p = Path::new(wt_dir)
                        .join("HEAD")
                        .to_string_lossy()
                        .into_owned();
                    phase3_paths.push(p.clone());
                    p
                })
            })
            .collect();

        let phase3_texts = read_git_files_bounded(
            &phase3_paths,
            blocked,
            deadline_ms,
            max_git_file_bytes,
            max_threads,
            timed_out_acc,
        );

        for ((repo, config_path), head_path) in repositories
            .into_iter()
            .zip(config_paths)
            .zip(head_paths)
        {
            let config_text = phase3_texts
                .get(&config_path)
                .map(String::as_str)
                .unwrap_or("");
            let origin_url = parse_origin_url_from_git_config(config_text);
            let is_bare = is_bare_git_config(config_text);
            let config_present = !config_text.is_empty();

            if let Some(wt_git_dir) = repo.worktree_git_dir
                && !is_bare
            {
                let git_dir_path = Path::new(&repo.git_dir);
                let is_dot_git = git_dir_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n == ".git")
                    .unwrap_or(false);
                let main_checkout = if config_present && is_dot_git {
                    git_dir_path
                        .parent()
                        .map(|p| p.to_string_lossy().into_owned())
                } else {
                    None
                };
                let head_branch = head_path
                    .as_deref()
                    .and_then(|p| phase3_texts.get(p))
                    .and_then(|t| parse_head_branch(t));
                identity_map.insert(
                    repo.directory.clone(),
                    GitDirectoryIdentity {
                        directory: repo.directory,
                        kind: GitIdentityKind::Worktree,
                        git_dir: Some(wt_git_dir),
                        main_checkout,
                        origin_url,
                        is_bare: false,
                        config_present,
                        has_git: true,
                        head_branch,
                    },
                );
            } else {
                identity_map.insert(
                    repo.directory.clone(),
                    GitDirectoryIdentity {
                        directory: repo.directory,
                        kind: GitIdentityKind::Repository,
                        git_dir: Some(repo.git_dir),
                        main_checkout: None,
                        origin_url,
                        is_bare,
                        config_present,
                        has_git: true,
                        head_branch: None,
                    },
                );
            }
        }
    }

    unique_dirs
        .into_iter()
        .filter_map(|d| identity_map.remove(&d))
        .collect()
}

fn read_head_branches(
    head_git_dirs: &[String],
    blocked: &HashSet<String>,
    deadline_ms: u64,
    max_git_file_bytes: usize,
    max_threads: usize,
    timed_out_acc: &mut Vec<String>,
) -> Vec<HeadBranchResult> {
    let head_paths: Vec<String> = head_git_dirs
        .iter()
        .map(|d| Path::new(d).join("HEAD").to_string_lossy().into_owned())
        .collect();
    let texts = read_git_files_bounded(
        &head_paths,
        blocked,
        deadline_ms,
        max_git_file_bytes,
        max_threads,
        timed_out_acc,
    );
    head_git_dirs
        .iter()
        .zip(head_paths)
        .map(|(git_dir, head_path)| HeadBranchResult {
            git_dir: git_dir.clone(),
            branch: texts.get(&head_path).and_then(|t| parse_head_branch(t)),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_test_dir(label: &str) -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "zerocode-session-scan-{label}-{}-{id}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scans_claude_codex_plain_and_zstd_and_pi_transcripts() {
        let root = temp_test_dir("providers");
        let claude_home = root.join("claude");
        let codex_home = root.join("codex");
        let pi_nested = root.join("pi-nested");
        let pi_flat = root.join("pi-flat");
        let ws_claude = root.join("ws-claude");
        let ws_claude_img = root.join("ws-claude-img");
        let ws_codex = root.join("ws-codex");
        let ws_codex_zst = root.join("ws-codex-zst");
        let ws_pi_nested = root.join("ws-pi-nested");
        let ws_pi_flat = root.join("ws-pi-flat");

        // Claude: later-line cwd + malformed line + >1 MiB line with early top-level cwd.
        let claude_dir = claude_home.join("projects").join("-p1");
        fs::create_dir_all(&claude_dir).unwrap();
        fs::write(
            claude_dir.join("later.jsonl"),
            format!(
                "not json\n{{\"type\":\"queue-operation\"}}\n{{\"type\":\"user\",\"cwd\":{},\"sessionId\":\"s1\"}}\n",
                serde_json::to_string(&ws_claude.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let huge_padding = "A".repeat(1_200 * 1024);
        fs::write(
            claude_dir.join("large-image.jsonl"),
            format!(
                "{{\"type\":\"user\",\"cwd\":{},\"message\":{{\"content\":\"{huge_padding}\"}}}}\n",
                serde_json::to_string(&ws_claude_img.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        fs::write(claude_dir.join("broken.jsonl"), "totally broken\n{\"type\":\"summary\"}\n")
            .unwrap();

        // Codex: plain rollout, zstd rollout, corrupt zstd, and subagent exclusion.
        let codex_day = codex_home.join("sessions").join("2026").join("08").join("24");
        fs::create_dir_all(&codex_day).unwrap();
        fs::write(
            codex_day.join("rollout-2026-08-24T10-00-00-aaa.jsonl"),
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"aaa\",\"cwd\":{}}}}}\n",
                serde_json::to_string(&ws_codex.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let zst_payload = format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"bbb\",\"cwd\":{}}}}}\n",
            serde_json::to_string(&ws_codex_zst.to_string_lossy()).unwrap()
        );
        fs::write(
            codex_day.join("rollout-2026-08-24T11-00-00-bbb.jsonl.zst"),
            zstd::stream::encode_all(zst_payload.as_bytes(), 3).unwrap(),
        )
        .unwrap();
        fs::write(
            codex_day.join("rollout-2026-08-24T11-30-00-corrupt.jsonl.zst"),
            b"not a zstd frame",
        )
        .unwrap();
        fs::write(
            codex_day.join("rollout-2026-08-24T12-00-00-sub.jsonl"),
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"sub\",\"cwd\":{},\"source\":{{\"subagent\":\"review\"}}}}}}\n{{\"type\":\"turn_context\",\"payload\":{{\"cwd\":{}}}}}\n",
                serde_json::to_string(&ws_codex.to_string_lossy()).unwrap(),
                serde_json::to_string(&ws_codex.to_string_lossy()).unwrap(),
            ),
        )
        .unwrap();
        fs::write(
            codex_day.join("rollout-2026-08-24T12-01-00-sub2.jsonl"),
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"sub2\",\"cwd\":{},\"source\":{{\"subAgent\":\"compact\"}}}}}}\n",
                serde_json::to_string(&ws_codex.to_string_lossy()).unwrap(),
            ),
        )
        .unwrap();

        // Pi: nested session ignoring truncated header & message cwd, plus flat session.
        let pi_slug = pi_nested.join("--slug--");
        fs::create_dir_all(&pi_slug).unwrap();
        fs::create_dir_all(&pi_flat).unwrap();
        let truncated_header = format!(
            "{{\"type\":\"session\",\"cwd\":{}",
            serde_json::to_string("/wrong-truncated").unwrap()
        );
        let msg_line = format!(
            "{{\"type\":\"message\",\"cwd\":{}}}",
            serde_json::to_string("/wrong-message").unwrap()
        );
        let valid_header = format!(
            "{{\"type\":\"session\",\"version\":3,\"id\":\"p1\",\"cwd\":{}}}",
            serde_json::to_string(&format!("  {}  ", ws_pi_nested.to_string_lossy())).unwrap()
        );
        fs::write(
            pi_slug.join("nested.jsonl"),
            format!("{truncated_header}\n{msg_line}\n{valid_header}\n"),
        )
        .unwrap();
        fs::write(
            pi_flat.join("flat.jsonl"),
            format!(
                "{{\"type\":\"session\",\"id\":\"p2\",\"cwd\":{}}}\n",
                serde_json::to_string(&ws_pi_flat.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();

        let response = run_session_scan(&SessionScanRequest {
            version: SESSION_SCAN_PROTOCOL_VERSION,
            max_threads: Some(4),
            read_deadline_ms: 2_000,
            max_git_file_bytes: 1024 * 1024,
            sources: vec![
                SourceScanRequest {
                    source: ProviderSource::ClaudeAgent,
                    homes: vec![SourceHome {
                        provider_instance_id: "claudeAgent".into(),
                        home_path: claude_home.to_string_lossy().into_owned(),
                    }],
                    limits: SourceLimits::default(),
                    cached_hints: vec![],
                },
                SourceScanRequest {
                    source: ProviderSource::Codex,
                    homes: vec![SourceHome {
                        provider_instance_id: "codex".into(),
                        home_path: codex_home.to_string_lossy().into_owned(),
                    }],
                    limits: SourceLimits::default(),
                    cached_hints: vec![],
                },
                SourceScanRequest {
                    source: ProviderSource::Pi,
                    homes: vec![
                        SourceHome {
                            provider_instance_id: "pi".into(),
                            home_path: pi_nested.to_string_lossy().into_owned(),
                        },
                        SourceHome {
                            provider_instance_id: "pi-flat".into(),
                            home_path: pi_flat.to_string_lossy().into_owned(),
                        },
                    ],
                    limits: SourceLimits::default(),
                    cached_hints: vec![],
                },
            ],
            git_directories: vec![],
            blocked_git_paths: vec![],
            head_git_dirs: vec![],
        });

        assert!(response.ok);
        assert_eq!(response.sources.len(), 3);

        let mut claude_cwds: Vec<String> = response.sources[0]
            .transcripts
            .iter()
            .map(|t| t.cwd.clone())
            .collect();
        claude_cwds.sort();
        let mut expected_claude = vec![
            ws_claude.to_string_lossy().into_owned(),
            ws_claude_img.to_string_lossy().into_owned(),
        ];
        expected_claude.sort();
        assert_eq!(claude_cwds, expected_claude);

        let mut codex_cwds: Vec<String> = response.sources[1]
            .transcripts
            .iter()
            .map(|t| t.cwd.clone())
            .collect();
        codex_cwds.sort();
        let mut expected_codex = vec![
            ws_codex.to_string_lossy().into_owned(),
            ws_codex_zst.to_string_lossy().into_owned(),
        ];
        expected_codex.sort();
        assert_eq!(codex_cwds, expected_codex);

        let mut pi_cwds: Vec<String> = response.sources[2]
            .transcripts
            .iter()
            .map(|t| t.cwd.clone())
            .collect();
        pi_cwds.sort();
        let mut expected_pi = vec![
            ws_pi_nested.to_string_lossy().into_owned(),
            ws_pi_flat.to_string_lossy().into_owned(),
        ];
        expected_pi.sort();
        assert_eq!(pi_cwds, expected_pi);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn honors_cached_hints_and_metadata_record_budget() {
        let root = temp_test_dir("hints");
        let claude_home = root.join("claude");
        let proj = claude_home.join("projects").join("-p");
        fs::create_dir_all(&proj).unwrap();

        let file_a = proj.join("a.jsonl");
        let file_b = proj.join("b.jsonl");
        let content_a = "{}\n{}\n{\"type\":\"user\",\"cwd\":\"/ws-a\"}\n";
        let content_b = "{}\n{}\n{\"type\":\"user\",\"cwd\":\"/ws-b\"}\n";
        fs::write(&file_a, content_a).unwrap();
        fs::write(&file_b, content_b).unwrap();

        let meta_a = fs::metadata(&file_a).unwrap();
        let (dev_a, ino_a) = metadata_device_and_inode(&meta_a);
        let mtime_a = system_time_to_ms(meta_a.modified().unwrap());
        let birth_a = metadata_birthtime_ms(&meta_a);

        // Record budget = 3: without hints, only 1 transcript fits (3 records each), truncating the second.
        let limits = SourceLimits {
            max_metadata_records: 3,
            ..SourceLimits::default()
        };
        let without_hints = run_session_scan(&SessionScanRequest {
            version: SESSION_SCAN_PROTOCOL_VERSION,
            max_threads: Some(2),
            read_deadline_ms: 2_000,
            max_git_file_bytes: 1024 * 1024,
            sources: vec![SourceScanRequest {
                source: ProviderSource::ClaudeAgent,
                homes: vec![SourceHome {
                    provider_instance_id: "claudeAgent".into(),
                    home_path: claude_home.to_string_lossy().into_owned(),
                }],
                limits: limits.clone(),
                cached_hints: vec![],
            }],
            git_directories: vec![],
            blocked_git_paths: vec![],
            head_git_dirs: vec![],
        });
        assert!(without_hints.sources[0].metadata_truncated);
        assert_eq!(without_hints.sources[0].transcripts.len(), 1);

        // With matching cached hint for file_a, file_a spends 0 records so file_b also fits!
        let with_hint = run_session_scan(&SessionScanRequest {
            version: SESSION_SCAN_PROTOCOL_VERSION,
            max_threads: Some(2),
            read_deadline_ms: 2_000,
            max_git_file_bytes: 1024 * 1024,
            sources: vec![SourceScanRequest {
                source: ProviderSource::ClaudeAgent,
                homes: vec![SourceHome {
                    provider_instance_id: "claudeAgent".into(),
                    home_path: claude_home.to_string_lossy().into_owned(),
                }],
                limits,
                cached_hints: vec![CachedHint {
                    provider_instance_id: "claudeAgent".into(),
                    file_path: file_a.to_string_lossy().into_owned(),
                    cwd: "/ws-a".into(),
                    size: meta_a.len(),
                    mtime_ms: Some(mtime_a),
                    device: dev_a,
                    inode: ino_a,
                    birthtime_ms: birth_a,
                }],
            }],
            git_directories: vec![],
            blocked_git_paths: vec![],
            head_git_dirs: vec![],
        });
        assert!(!with_hint.sources[0].metadata_truncated);
        assert_eq!(with_hint.sources[0].transcripts.len(), 2);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolves_git_repos_worktrees_bare_submodules_and_config_edge_cases() {
        let root = temp_test_dir("git");
        let repo = root.join("repo");
        let worktree = root.join("wt");
        let bare = root.join("bare");
        let bare_wt = root.join("bare-wt");
        let submodule = root.join("submodule");
        let plain = root.join("plain");
        let unknown = root.join("unknown");
        let unknown_wt = root.join("unknown-wt");

        fs::create_dir_all(repo.join(".git").join("worktrees").join("feat")).unwrap();
        fs::write(
            repo.join(".git").join("config"),
            "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = git@github.com:feelmypain/zerocode.git\n",
        )
        .unwrap();
        let wt_git_dir = repo.join(".git").join("worktrees").join("feat");
        fs::write(wt_git_dir.join("commondir"), "../..\n").unwrap();
        fs::write(wt_git_dir.join("HEAD"), "ref: refs/heads/feat/native-scan\n").unwrap();
        fs::create_dir_all(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", wt_git_dir.to_string_lossy()),
        )
        .unwrap();

        // Bare repo with inline `[core] bare = "true" ; comment` and linked worktree.
        fs::create_dir_all(bare.join(".git").join("worktrees").join("dev")).unwrap();
        fs::write(
            bare.join(".git").join("config"),
            "[core] bare = \"true\" ; bare repo\n[remote.Origin]\n\turl = https://github.com/feelmypain/bare.git\n",
        )
        .unwrap();
        let bare_wt_git = bare.join(".git").join("worktrees").join("dev");
        fs::write(bare_wt_git.join("commondir"), "../..\n").unwrap();
        fs::create_dir_all(&bare_wt).unwrap();
        fs::write(
            bare_wt.join(".git"),
            format!("gitdir: {}\n", bare_wt_git.to_string_lossy()),
        )
        .unwrap();

        // Submodule pointing to `.git/modules/vendor`.
        let sub_git = repo.join(".git").join("modules").join("vendor");
        fs::create_dir_all(&sub_git).unwrap();
        fs::write(
            sub_git.join("config"),
            "[remote \"upstream\"]\n\turl = ssh://gitlab.com/feelmypain/vendor.git\n",
        )
        .unwrap();
        fs::create_dir_all(&submodule).unwrap();
        fs::write(
            submodule.join(".git"),
            format!("gitdir: {}\n", sub_git.to_string_lossy()),
        )
        .unwrap();

        // Worktree whose common dir config is missing (cannot rule out bare -> main_checkout None).
        let unk_wt_git = unknown.join(".git").join("worktrees").join("wt");
        fs::create_dir_all(&unk_wt_git).unwrap();
        fs::write(unk_wt_git.join("commondir"), "../..\n").unwrap();
        fs::create_dir_all(&unknown_wt).unwrap();
        fs::write(
            unknown_wt.join(".git"),
            format!("gitdir: {}\n", unk_wt_git.to_string_lossy()),
        )
        .unwrap();

        fs::create_dir_all(&plain).unwrap();

        let response = run_session_scan(&SessionScanRequest {
            version: SESSION_SCAN_PROTOCOL_VERSION,
            max_threads: Some(4),
            read_deadline_ms: 2_000,
            max_git_file_bytes: 1024 * 1024,
            sources: vec![],
            git_directories: vec![
                repo.to_string_lossy().into_owned(),
                worktree.to_string_lossy().into_owned(),
                bare.to_string_lossy().into_owned(),
                bare_wt.to_string_lossy().into_owned(),
                submodule.to_string_lossy().into_owned(),
                plain.to_string_lossy().into_owned(),
                unknown_wt.to_string_lossy().into_owned(),
            ],
            blocked_git_paths: vec![],
            head_git_dirs: vec![],
        });

        let by_dir: HashMap<&str, &GitDirectoryIdentity> = response
            .git_identities
            .iter()
            .map(|id| (id.directory.as_str(), id))
            .collect();

        let r = by_dir[repo.to_string_lossy().as_ref()];
        assert_eq!(r.kind, GitIdentityKind::Repository);
        assert_eq!(
            r.origin_url.as_deref(),
            Some("git@github.com:feelmypain/zerocode.git")
        );

        let w = by_dir[worktree.to_string_lossy().as_ref()];
        assert_eq!(w.kind, GitIdentityKind::Worktree);
        assert_eq!(
            w.main_checkout.as_deref(),
            Some(repo.to_string_lossy().as_ref())
        );
        assert_eq!(w.head_branch.as_deref(), Some("feat/native-scan"));
        assert_eq!(
            w.origin_url.as_deref(),
            Some("git@github.com:feelmypain/zerocode.git")
        );

        let bw = by_dir[bare_wt.to_string_lossy().as_ref()];
        assert_eq!(bw.kind, GitIdentityKind::Repository);
        assert!(bw.is_bare);
        assert_eq!(
            bw.origin_url.as_deref(),
            Some("https://github.com/feelmypain/bare.git")
        );

        let s = by_dir[submodule.to_string_lossy().as_ref()];
        assert_eq!(s.kind, GitIdentityKind::Repository);
        assert_eq!(
            s.origin_url.as_deref(),
            Some("ssh://gitlab.com/feelmypain/vendor.git")
        );

        let p = by_dir[plain.to_string_lossy().as_ref()];
        assert_eq!(p.kind, GitIdentityKind::NotGit);

        let u = by_dir[unknown_wt.to_string_lossy().as_ref()];
        assert_eq!(u.kind, GitIdentityKind::Worktree);
        assert_eq!(u.main_checkout, None);
        assert!(!u.config_present);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parses_git_config_continuations_quotes_and_numeric_booleans() {
        assert!(is_bare_git_config("[core]\n\tbare = 1\n"));
        assert!(is_bare_git_config("[core]\n\tbare = 1k\n"));
        assert!(is_bare_git_config("[core]\n\tbare\n"));
        assert!(!is_bare_git_config("[core]\n\tbare = 0\n"));
        assert!(!is_bare_git_config("[core]\n\tbare = 0x0\n"));
        assert!(!is_bare_git_config("[core]\n\tbare = 99999999999\n"));
        assert_eq!(
            parse_origin_url_from_git_config(
                "[remote \"upstream\"]\n\turl = https://example.com/a/b.git\n[remote \"origin\"]\n\turl = \"https://github.com/org/\\\nrepo.git\" # comment\n"
            ),
            Some("https://github.com/org/repo.git".to_string())
        );
    }

    #[test]
    fn parses_unicode_surrogates_and_escaped_cwd() {
        let mut parser = CwdLineParser::new(ProviderSource::Pi, DEFAULT_MAX_TRANSCRIPT_SCAN_BYTES);
        let line = br#"{"type":"session","cwd":"/tmp/\uD83D\uDE80/app"}"#;
        // Feed 1 byte at a time to stress chunk-boundary handling across escapes.
        for b in line {
            parser.feed(&[*b]);
        }
        assert_eq!(
            parser.finish_line().unwrap(),
            CwdOutcome::Found("/tmp/\u{1F680}/app".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn skips_fifos_without_blocking() {
        use std::process::Command;

        let root = temp_test_dir("fifo");
        let repo_fifo_cfg = root.join("repo-fifo-cfg");
        let repo_fifo_git = root.join("repo-fifo-git");
        let repo_ok = root.join("repo-ok");
        let claude_home = root.join("claude");
        let claude_proj = claude_home.join("projects").join("-fifo");
        fs::create_dir_all(repo_fifo_cfg.join(".git")).unwrap();
        fs::create_dir_all(&repo_fifo_git).unwrap();
        fs::create_dir_all(repo_ok.join(".git")).unwrap();
        fs::create_dir_all(&claude_proj).unwrap();

        fs::write(
            repo_ok.join(".git").join("config"),
            "[remote \"origin\"]\n\turl = git@github.com:feelmypain/ok.git\n",
        )
        .unwrap();

        for fifo in [
            repo_fifo_cfg.join(".git").join("config"),
            repo_fifo_git.join(".git"),
            claude_proj.join("fifo.jsonl"),
        ] {
            let status = Command::new("mkfifo").arg(&fifo).status().unwrap();
            assert!(status.success());
        }

        let start = Instant::now();
        let response = run_session_scan(&SessionScanRequest {
            version: SESSION_SCAN_PROTOCOL_VERSION,
            max_threads: Some(4),
            read_deadline_ms: 2_000,
            max_git_file_bytes: 1024 * 1024,
            sources: vec![SourceScanRequest {
                source: ProviderSource::ClaudeAgent,
                homes: vec![SourceHome {
                    provider_instance_id: "claudeAgent".into(),
                    home_path: claude_home.to_string_lossy().into_owned(),
                }],
                limits: SourceLimits::default(),
                cached_hints: vec![],
            }],
            git_directories: vec![
                repo_fifo_cfg.to_string_lossy().into_owned(),
                repo_fifo_git.to_string_lossy().into_owned(),
                repo_ok.to_string_lossy().into_owned(),
            ],
            blocked_git_paths: vec![],
            head_git_dirs: vec![],
        });

        // Skipping non-regular files via metadata().is_file() completes instantaneously, well below 2s.
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(response.sources[0].transcripts.is_empty());
        assert!(response.timed_out_git_paths.is_empty());

        let by_dir: HashMap<&str, &GitDirectoryIdentity> = response
            .git_identities
            .iter()
            .map(|id| (id.directory.as_str(), id))
            .collect();
        assert_eq!(
            by_dir[repo_fifo_cfg.to_string_lossy().as_ref()].origin_url,
            None
        );
        assert_eq!(
            by_dir[repo_fifo_git.to_string_lossy().as_ref()].kind,
            GitIdentityKind::NotGit
        );
        assert_eq!(
            by_dir[repo_ok.to_string_lossy().as_ref()]
                .origin_url
                .as_deref(),
            Some("git@github.com:feelmypain/ok.git")
        );

        let _ = fs::remove_dir_all(&root);
    }
}
