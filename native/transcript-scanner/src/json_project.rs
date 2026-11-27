use std::collections::HashMap;
use std::io;

use memchr::memchr2;
use serde::Deserialize;

/// Declarative field tree matching `SelectedFields` from `@zerocode/provider-core/server/usage`.
#[derive(Debug, Clone)]
pub enum SelectNode {
    All,
    Object(HashMap<String, SelectNode>),
}

impl<'de> Deserialize<'de> for SelectNode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = SelectNode;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("true or a nested object of selected fields")
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                if value {
                    Ok(SelectNode::All)
                } else {
                    Err(E::custom("selectFields boolean leaf must be true"))
                }
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                let mut entries = HashMap::new();
                while let Some((key, value)) = map.next_entry::<String, SelectNode>()? {
                    entries.insert(key, value);
                }
                Ok(SelectNode::Object(entries))
            }
        }

        deserializer.deserialize_any(Visitor)
    }
}

/// Abstract byte cursor so the same iterative JSON projector runs over both
/// contiguous `&[u8]` lines and chunk-streamed oversized lines with bounded RAM.
pub trait ByteSource {
    fn peek_slice(&mut self) -> io::Result<&[u8]>;
    fn consume(&mut self, count: usize);
}

pub struct SliceSource<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> SliceSource<'a> {
    #[inline]
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }
}

impl ByteSource for SliceSource<'_> {
    #[inline]
    fn peek_slice(&mut self) -> io::Result<&[u8]> {
        Ok(&self.bytes[self.pos..])
    }

    #[inline]
    fn consume(&mut self, count: usize) {
        self.pos += count;
    }
}

#[derive(Debug)]
pub enum ProjectError {
    Malformed,
    Io(io::Error),
}

impl From<io::Error> for ProjectError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

enum Container<'a> {
    Object {
        select: Option<&'a SelectNode>,
        first_in_input: bool,
        first_emitted: bool,
        emit_braces: bool,
    },
    Array {
        emit_elements: bool,
        emit_brackets: bool,
        first_in_input: bool,
    },
}

#[inline]
fn is_ws(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
}

#[inline]
fn peek_byte<S: ByteSource>(src: &mut S) -> Result<Option<u8>, ProjectError> {
    let slice = src.peek_slice()?;
    Ok(slice.first().copied())
}

#[inline]
fn next_byte<S: ByteSource>(src: &mut S) -> Result<Option<u8>, ProjectError> {
    let slice = src.peek_slice()?;
    if let Some(&byte) = slice.first() {
        src.consume(1);
        Ok(Some(byte))
    } else {
        Ok(None)
    }
}

#[inline]
fn skip_ws<S: ByteSource>(src: &mut S) -> Result<(), ProjectError> {
    loop {
        let slice = src.peek_slice()?;
        let slice_len = slice.len();
        if slice_len == 0 {
            return Ok(());
        }
        let mut idx = 0;
        while idx < slice_len && is_ws(slice[idx]) {
            idx += 1;
        }
        if idx > 0 {
            src.consume(idx);
        }
        if idx < slice_len {
            return Ok(());
        }
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

fn read_hex4<S: ByteSource>(
    src: &mut S,
    raw_out: Option<&mut Vec<u8>>,
) -> Result<u16, ProjectError> {
    let mut digits = [0u8; 4];
    let mut value: u16 = 0;
    for slot in &mut digits {
        let byte = next_byte(src)?.ok_or(ProjectError::Malformed)?;
        let nibble = hex_val(byte).ok_or(ProjectError::Malformed)?;
        value = (value << 4) | nibble;
        *slot = byte;
    }
    if let Some(out) = raw_out {
        out.extend_from_slice(&digits);
    }
    Ok(value)
}

/// Appends valid UTF-8 chunks verbatim and replaces malformed UTF-8 sequences with U+FFFD,
/// matching Node's `Buffer.toString("utf8")` so stdout always remains valid UTF-8.
fn push_lossy_utf8(out: &mut Vec<u8>, bytes: &[u8]) {
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(valid) => {
                out.extend_from_slice(valid.as_bytes());
                return;
            }
            Err(error) => {
                let valid_len = error.valid_up_to();
                if valid_len > 0 {
                    out.extend_from_slice(&rest[..valid_len]);
                }
                out.extend_from_slice("\u{FFFD}".as_bytes());
                match error.error_len() {
                    Some(invalid_len) => rest = &rest[valid_len + invalid_len..],
                    None => return,
                }
            }
        }
    }
}

/// Fast-path string scanner using SIMD `memchr2` over chunk slices.
/// Assumes the opening `"` has already been consumed.
fn scan_string_value<S: ByteSource>(
    src: &mut S,
    emit: bool,
    out: &mut Vec<u8>,
) -> Result<(), ProjectError> {
    if emit {
        out.push(b'"');
    }
    // Buffer trailing incomplete UTF-8 sequence across chunk boundaries when emitting.
    let mut pending_utf8 = [0u8; 4];
    let mut pending_len: usize = 0;

    loop {
        let slice = src.peek_slice()?;
        if slice.is_empty() {
            return Err(ProjectError::Malformed);
        }
        match memchr2(b'"', b'\\', slice) {
            Some(idx) => {
                let span = &slice[..idx];
                if span.iter().any(|&b| b < 0x20) {
                    return Err(ProjectError::Malformed);
                }
                let delim = slice[idx];
                if emit {
                    emit_string_span(out, &mut pending_utf8, &mut pending_len, span, true);
                }
                src.consume(idx + 1);
                if delim == b'"' {
                    if emit {
                        out.push(b'"');
                    }
                    return Ok(());
                }
                // Escape sequence after `\`
                let esc = next_byte(src)?.ok_or(ProjectError::Malformed)?;
                match esc {
                    b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => {
                        if emit {
                            out.push(b'\\');
                            out.push(esc);
                        }
                    }
                    b'u' => {
                        if emit {
                            out.extend_from_slice(b"\\u");
                            read_hex4(src, Some(out))?;
                        } else {
                            read_hex4(src, None)?;
                        }
                    }
                    _ => return Err(ProjectError::Malformed),
                }
            }
            None => {
                if slice.iter().any(|&b| b < 0x20) {
                    return Err(ProjectError::Malformed);
                }
                let len = slice.len();
                if emit {
                    emit_string_span(out, &mut pending_utf8, &mut pending_len, slice, false);
                }
                src.consume(len);
            }
        }
    }
}

fn emit_string_span(
    out: &mut Vec<u8>,
    pending: &mut [u8; 4],
    pending_len: &mut usize,
    span: &[u8],
    flush_tail: bool,
) {
    if *pending_len == 0 && span.is_ascii() {
        out.extend_from_slice(span);
        return;
    }

    // Complete any pending multi-byte sequence from the previous chunk.
    let mut rest = span;
    if *pending_len > 0 {
        while *pending_len < 4 && !rest.is_empty() {
            pending[*pending_len] = rest[0];
            *pending_len += 1;
            rest = &rest[1..];
            match std::str::from_utf8(&pending[..*pending_len]) {
                Ok(valid) => {
                    out.extend_from_slice(valid.as_bytes());
                    *pending_len = 0;
                    break;
                }
                Err(error) => {
                    if let Some(bad) = error.error_len() {
                        out.extend_from_slice("\u{FFFD}".as_bytes());
                        let rem = *pending_len - bad;
                        pending.copy_within(bad..*pending_len, 0);
                        *pending_len = rem;
                        if rem == 0 {
                            break;
                        }
                        if let Ok(valid) = std::str::from_utf8(&pending[..rem]) {
                            out.extend_from_slice(valid.as_bytes());
                            *pending_len = 0;
                            break;
                        }
                    }
                }
            }
        }
        if *pending_len > 0 {
            if flush_tail {
                push_lossy_utf8(out, &pending[..*pending_len]);
                *pending_len = 0;
            }
            if rest.is_empty() {
                return;
            }
        }
    }

    loop {
        match std::str::from_utf8(rest) {
            Ok(valid) => {
                out.extend_from_slice(valid.as_bytes());
                return;
            }
            Err(error) => {
                let valid_len = error.valid_up_to();
                if valid_len > 0 {
                    out.extend_from_slice(&rest[..valid_len]);
                }
                match error.error_len() {
                    Some(invalid_len) => {
                        out.extend_from_slice("\u{FFFD}".as_bytes());
                        rest = &rest[valid_len + invalid_len..];
                    }
                    None => {
                        let tail = &rest[valid_len..];
                        if flush_tail {
                            out.extend_from_slice("\u{FFFD}".as_bytes());
                        } else {
                            pending[..tail.len()].copy_from_slice(tail);
                            *pending_len = tail.len();
                        }
                        return;
                    }
                }
            }
        }
    }
}

/// Scans an object key string. If `decode_key` is true, unescapes into `key_buf`
/// (including `\uXXXX` and UTF-16 surrogate pairs) for `SelectNode::Object` lookup.
/// If `emit_raw` is true, writes the raw JSON string directly into `raw_buf`.
fn scan_object_key<S: ByteSource>(
    src: &mut S,
    decode_key: bool,
    emit_raw: bool,
    key_buf: &mut String,
    raw_buf: &mut Vec<u8>,
) -> Result<(), ProjectError> {
    let quote = next_byte(src)?.ok_or(ProjectError::Malformed)?;
    if quote != b'"' {
        return Err(ProjectError::Malformed);
    }
    if decode_key {
        key_buf.clear();
    }
    if emit_raw {
        raw_buf.clear();
        raw_buf.push(b'"');
    }

    if !decode_key && !emit_raw {
        return scan_string_value(src, false, raw_buf);
    }

    // Read raw escaped content into a scratch buffer if decoding, or directly stream when emitting only.
    let mut scratch: Vec<u8> = Vec::new();
    let mut pending_utf8 = [0u8; 4];
    let mut pending_len: usize = 0;

    loop {
        let slice = src.peek_slice()?;
        if slice.is_empty() {
            return Err(ProjectError::Malformed);
        }
        match memchr2(b'"', b'\\', slice) {
            Some(idx) => {
                let span = &slice[..idx];
                if span.iter().any(|&b| b < 0x20) {
                    return Err(ProjectError::Malformed);
                }
                let delim = slice[idx];
                if emit_raw {
                    emit_string_span(raw_buf, &mut pending_utf8, &mut pending_len, span, true);
                }
                if decode_key {
                    scratch.extend_from_slice(span);
                }
                src.consume(idx + 1);
                if delim == b'"' {
                    if emit_raw {
                        raw_buf.push(b'"');
                    }
                    if decode_key {
                        push_decoded_utf8(key_buf, &scratch);
                    }
                    return Ok(());
                }
                // Flush buffered raw bytes before decoding the escape sequence.
                if decode_key && !scratch.is_empty() {
                    push_decoded_utf8(key_buf, &scratch);
                    scratch.clear();
                }
                let esc = next_byte(src)?.ok_or(ProjectError::Malformed)?;
                match esc {
                    b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => {
                        if emit_raw {
                            raw_buf.push(b'\\');
                            raw_buf.push(esc);
                        }
                        if decode_key {
                            key_buf.push(match esc {
                                b'"' => '"',
                                b'\\' => '\\',
                                b'/' => '/',
                                b'b' => '\u{0008}',
                                b'f' => '\u{000C}',
                                b'n' => '\n',
                                b'r' => '\r',
                                b't' => '\t',
                                _ => unreachable!(),
                            });
                        }
                    }
                    b'u' => {
                        if emit_raw {
                            raw_buf.extend_from_slice(b"\\u");
                        }
                        let code = read_hex4(src, if emit_raw { Some(raw_buf) } else { None })?;
                        if decode_key {
                            decode_unicode_escape(src, code, emit_raw, key_buf, raw_buf)?;
                        }
                    }
                    _ => return Err(ProjectError::Malformed),
                }
            }
            None => {
                if slice.iter().any(|&b| b < 0x20) {
                    return Err(ProjectError::Malformed);
                }
                let len = slice.len();
                if emit_raw {
                    emit_string_span(raw_buf, &mut pending_utf8, &mut pending_len, slice, false);
                }
                if decode_key {
                    scratch.extend_from_slice(slice);
                }
                src.consume(len);
            }
        }
    }
}

fn push_decoded_utf8(key_buf: &mut String, bytes: &[u8]) {
    if let Ok(text) = std::str::from_utf8(bytes) {
        key_buf.push_str(text);
    } else {
        key_buf.push_str(&String::from_utf8_lossy(bytes));
    }
}

fn decode_unicode_escape<S: ByteSource>(
    src: &mut S,
    first: u16,
    emit_raw: bool,
    key_buf: &mut String,
    raw_buf: &mut Vec<u8>,
) -> Result<(), ProjectError> {
    if (0xD800..=0xDBFF).contains(&first) {
        // High surrogate: check if immediately followed by `\uXXXX` low surrogate.
        if peek_byte(src)? == Some(b'\\') {
            src.consume(1);
            let esc = next_byte(src)?.ok_or(ProjectError::Malformed)?;
            if esc == b'u' {
                if emit_raw {
                    raw_buf.extend_from_slice(b"\\u");
                }
                let second = read_hex4(src, if emit_raw { Some(raw_buf) } else { None })?;
                if (0xDC00..=0xDFFF).contains(&second) {
                    let combined =
                        0x10000 + (((first as u32 - 0xD800) << 10) | (second as u32 - 0xDC00));
                    if let Some(ch) = char::from_u32(combined) {
                        key_buf.push(ch);
                        return Ok(());
                    }
                }
                // Lone high surrogate followed by another `\uXXXX`: recurse for `second`.
                key_buf.push('\u{FFFD}');
                return decode_unicode_escape(src, second, emit_raw, key_buf, raw_buf);
            }
            // High surrogate followed by a non-\u escape (e.g. \n).
            key_buf.push('\u{FFFD}');
            match esc {
                b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => {
                    if emit_raw {
                        raw_buf.push(b'\\');
                        raw_buf.push(esc);
                    }
                    key_buf.push(match esc {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{0008}',
                        b'f' => '\u{000C}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        _ => unreachable!(),
                    });
                    return Ok(());
                }
                _ => return Err(ProjectError::Malformed),
            }
        }
        key_buf.push('\u{FFFD}');
        return Ok(());
    }
    if let Some(ch) = char::from_u32(first as u32) {
        key_buf.push(ch);
    } else {
        key_buf.push('\u{FFFD}');
    }
    Ok(())
}

/// Validates RFC 8259 JSON number grammar and optionally copies exact raw bytes (including `1e400`).
fn scan_number<S: ByteSource>(
    src: &mut S,
    first: u8,
    emit: bool,
    out: &mut Vec<u8>,
) -> Result<(), ProjectError> {
    let mut cur = first;
    if cur == b'-' {
        if emit {
            out.push(b'-');
        }
        cur = next_byte(src)?.ok_or(ProjectError::Malformed)?;
    }
    match cur {
        b'0' => {
            if emit {
                out.push(b'0');
            }
            // RFC 8259 forbids leading zeros like `01`.
            if matches!(peek_byte(src)?, Some(b'0'..=b'9')) {
                return Err(ProjectError::Malformed);
            }
        }
        b'1'..=b'9' => {
            if emit {
                out.push(cur);
            }
            consume_digits(src, emit, out)?;
        }
        _ => return Err(ProjectError::Malformed),
    }

    if peek_byte(src)? == Some(b'.') {
        src.consume(1);
        if emit {
            out.push(b'.');
        }
        let digit = next_byte(src)?.ok_or(ProjectError::Malformed)?;
        if !digit.is_ascii_digit() {
            return Err(ProjectError::Malformed);
        }
        if emit {
            out.push(digit);
        }
        consume_digits(src, emit, out)?;
    }

    if matches!(peek_byte(src)?, Some(b'e' | b'E')) {
        let exp = next_byte(src)?.unwrap();
        if emit {
            out.push(exp);
        }
        if matches!(peek_byte(src)?, Some(b'+' | b'-')) {
            let sign = next_byte(src)?.unwrap();
            if emit {
                out.push(sign);
            }
        }
        let digit = next_byte(src)?.ok_or(ProjectError::Malformed)?;
        if !digit.is_ascii_digit() {
            return Err(ProjectError::Malformed);
        }
        if emit {
            out.push(digit);
        }
        consume_digits(src, emit, out)?;
    }

    Ok(())
}

#[inline]
fn consume_digits<S: ByteSource>(
    src: &mut S,
    emit: bool,
    out: &mut Vec<u8>,
) -> Result<(), ProjectError> {
    loop {
        let slice = src.peek_slice()?;
        let slice_len = slice.len();
        if slice_len == 0 {
            return Ok(());
        }
        let mut idx = 0;
        while idx < slice_len && slice[idx].is_ascii_digit() {
            idx += 1;
        }
        if idx > 0 {
            if emit {
                out.extend_from_slice(&slice[..idx]);
            }
            src.consume(idx);
        }
        if idx < slice_len {
            return Ok(());
        }
    }
}

fn expect_literal<S: ByteSource>(
    src: &mut S,
    rest: &[u8],
    emit: bool,
    full: &[u8],
    out: &mut Vec<u8>,
) -> Result<(), ProjectError> {
    for &expected in rest {
        let got = next_byte(src)?.ok_or(ProjectError::Malformed)?;
        if got != expected {
            return Err(ProjectError::Malformed);
        }
    }
    if emit {
        out.extend_from_slice(full);
    }
    Ok(())
}

/// Reusable scratch buffers so projecting thousands of lines incurs zero steady-state allocations.
#[derive(Default)]
pub struct ProjectorScratch {
    key_buf: String,
    raw_key_buf: Vec<u8>,
    pub out_buf: Vec<u8>,
}

/// Validates a complete RFC 8259 JSON value from `src` and writes the projected JSON
/// (keeping only paths accepted by `root_select`) into `scratch.out_buf`.
/// Returns `Ok(true)` if valid JSON was projected into `scratch.out_buf`, `Ok(false)` if
/// empty/whitespace or malformed JSON, or `Err(io::Error)` on underlying I/O failure.
pub fn project_json<S: ByteSource>(
    src: &mut S,
    root_select: &SelectNode,
    scratch: &mut ProjectorScratch,
) -> io::Result<bool> {
    scratch.out_buf.clear();
    match project_json_inner(src, root_select, scratch) {
        Ok(()) => Ok(true),
        Err(ProjectError::Malformed) => {
            scratch.out_buf.clear();
            Ok(false)
        }
        Err(ProjectError::Io(error)) => {
            scratch.out_buf.clear();
            Err(error)
        }
    }
}

fn project_json_inner<S: ByteSource>(
    src: &mut S,
    root_select: &SelectNode,
    scratch: &mut ProjectorScratch,
) -> Result<(), ProjectError> {
    skip_ws(src)?;
    if peek_byte(src)?.is_none() {
        return Err(ProjectError::Malformed);
    }

    let mut stack: Vec<Container<'_>> = Vec::with_capacity(32);
    let mut current_select: Option<&SelectNode> = Some(root_select);

    // State machine: either expecting a value (with `current_select`) or advancing top container.
    let mut expect_value = true;

    loop {
        if expect_value {
            skip_ws(src)?;
            let first = next_byte(src)?.ok_or(ProjectError::Malformed)?;
            match first {
                b'{' => {
                    let emit_braces = current_select.is_some();
                    if emit_braces {
                        scratch.out_buf.push(b'{');
                    }
                    stack.push(Container::Object {
                        select: current_select,
                        first_in_input: true,
                        first_emitted: true,
                        emit_braces,
                    });
                    expect_value = false;
                }
                b'[' => {
                    let emit_brackets = current_select.is_some();
                    let emit_elements = matches!(current_select, Some(SelectNode::All));
                    if emit_brackets {
                        scratch.out_buf.push(b'[');
                    }
                    stack.push(Container::Array {
                        emit_elements,
                        emit_brackets,
                        first_in_input: true,
                    });
                    expect_value = false;
                }
                b'"' => {
                    scan_string_value(src, current_select.is_some(), &mut scratch.out_buf)?;
                    expect_value = false;
                }
                b'-' | b'0'..=b'9' => {
                    scan_number(src, first, current_select.is_some(), &mut scratch.out_buf)?;
                    expect_value = false;
                }
                b't' => {
                    expect_literal(
                        src,
                        b"rue",
                        current_select.is_some(),
                        b"true",
                        &mut scratch.out_buf,
                    )?;
                    expect_value = false;
                }
                b'f' => {
                    expect_literal(
                        src,
                        b"alse",
                        current_select.is_some(),
                        b"false",
                        &mut scratch.out_buf,
                    )?;
                    expect_value = false;
                }
                b'n' => {
                    expect_literal(
                        src,
                        b"ull",
                        current_select.is_some(),
                        b"null",
                        &mut scratch.out_buf,
                    )?;
                    expect_value = false;
                }
                _ => return Err(ProjectError::Malformed),
            }
            if stack.is_empty() {
                break;
            }
            continue;
        }

        // Advance the innermost open container.
        skip_ws(src)?;
        match stack.last_mut() {
            None => break,
            Some(Container::Object {
                select,
                first_in_input,
                first_emitted,
                emit_braces,
            }) => {
                let next = peek_byte(src)?.ok_or(ProjectError::Malformed)?;
                if next == b'}' {
                    src.consume(1);
                    if *emit_braces {
                        scratch.out_buf.push(b'}');
                    }
                    stack.pop();
                    if stack.is_empty() {
                        break;
                    }
                    continue;
                }
                if *first_in_input {
                    *first_in_input = false;
                } else {
                    if next != b',' {
                        return Err(ProjectError::Malformed);
                    }
                    src.consume(1);
                    skip_ws(src)?;
                }

                let (decode_key, emit_raw) = match *select {
                    None => (false, false),
                    Some(SelectNode::All) => (false, true),
                    Some(SelectNode::Object(_)) => (true, true),
                };
                scan_object_key(
                    src,
                    decode_key,
                    emit_raw,
                    &mut scratch.key_buf,
                    &mut scratch.raw_key_buf,
                )?;
                skip_ws(src)?;
                if next_byte(src)? != Some(b':') {
                    return Err(ProjectError::Malformed);
                }

                let child_select = match *select {
                    None => None,
                    Some(SelectNode::All) => Some(&SelectNode::All),
                    Some(SelectNode::Object(map)) => map.get(&scratch.key_buf),
                };
                if child_select.is_some() {
                    if !*first_emitted {
                        scratch.out_buf.push(b',');
                    }
                    *first_emitted = false;
                    scratch.out_buf.extend_from_slice(&scratch.raw_key_buf);
                    scratch.out_buf.push(b':');
                }
                current_select = child_select;
                expect_value = true;
            }
            Some(Container::Array {
                emit_elements,
                emit_brackets,
                first_in_input,
            }) => {
                let next = peek_byte(src)?.ok_or(ProjectError::Malformed)?;
                if next == b']' {
                    src.consume(1);
                    if *emit_brackets {
                        scratch.out_buf.push(b']');
                    }
                    stack.pop();
                    if stack.is_empty() {
                        break;
                    }
                    continue;
                }
                if *first_in_input {
                    *first_in_input = false;
                } else {
                    if next != b',' {
                        return Err(ProjectError::Malformed);
                    }
                    src.consume(1);
                    if *emit_elements {
                        scratch.out_buf.push(b',');
                    }
                }
                current_select = if *emit_elements {
                    Some(&SelectNode::All)
                } else {
                    None
                };
                expect_value = true;
            }
        }
    }

    skip_ws(src)?;
    if peek_byte(src)?.is_some() {
        return Err(ProjectError::Malformed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn run_project(input: &str, select: &SelectNode) -> Option<String> {
        let mut src = SliceSource::new(input.as_bytes());
        let mut scratch = ProjectorScratch::default();
        if project_json(&mut src, select, &mut scratch).unwrap() {
            Some(String::from_utf8(scratch.out_buf).unwrap())
        } else {
            None
        }
    }

    #[test]
    fn projects_selected_fields_and_discards_large_unselected_content() {
        let select = claude_select();
        let line = r#"{"type":"assistant","timestamp":"2026-08-01T10:00:00Z","padding":"huge\"string\\with\"escapes","message":{"content":[{"type":"tool_use","input":{"text":"ignored"}}],"id":"m1","model":"claude-fable-5","usage":{"input_tokens":100,"output_tokens":99}}}"#;
        let out = run_project(line, &select).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["type"], "assistant");
        assert_eq!(parsed["message"]["id"], "m1");
        assert_eq!(parsed["message"]["usage"]["output_tokens"], 99);
        assert!(parsed.get("padding").is_none());
        assert!(parsed["message"].get("content").is_none());
    }

    #[test]
    fn handles_escaped_keys_duplicates_and_non_finite_numbers() {
        let select = claude_select();
        let line = r#"{"type":"user","type":"assistant","costUSD":1e400,"__proto__":{"type":"user"},"mess\u0061ge":{"id":"m1","usage":{"output_tokens":7}}}"#;
        let out = run_project(line, &select).unwrap();
        assert!(out.contains(r#""costUSD":1e400"#));
        assert!(out.contains(r#""type":"user","type":"assistant""#));
        assert!(out.contains(r#""mess\u0061ge":{"id":"m1","usage":{"output_tokens":7}}"#));
        assert!(!out.contains("__proto__"));
    }

    #[test]
    fn handles_deeply_nested_discarded_structures_without_stack_overflow() {
        let select = claude_select();
        let deep = format!(
            r#"{{"toolOutput":{},"type":"assistant","message":{{"id":"m1","usage":{{"output_tokens":99}}}}}}"#,
            format!("{}0{}", "[".repeat(1000), "]".repeat(1000))
        );
        let out = run_project(&deep, &select).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["message"]["usage"]["output_tokens"], 99);
    }

    #[test]
    fn rejects_malformed_and_trailing_junk() {
        let select = claude_select();
        let valid = r#"{"type":"assistant","message":{"id":"m1"}}"#;
        assert!(run_project(&format!("{valid} junk"), &select).is_none());
        assert!(run_project(&format!("{valid}{valid}"), &select).is_none());
        assert!(run_project(&valid[..valid.len() - 1], &select).is_none());
        assert!(run_project(r#"{"type":01}"#, &select).is_none());
        assert!(run_project(r#"{"type":"assistant",}"#, &select).is_none());
    }
}
