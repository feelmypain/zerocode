import { githubHeadingSlug } from "./markdownFragments";

// Definitions, footnotes, raw HTML, container directives and display math can tie blocks together.
const DOCUMENT_WIDE_SYNTAX = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|:::|\$\$)|\[\^/m;
// A backtick fence's info string cannot contain a backtick, so "```a``` is inline" is a code span.
const FENCE_PATTERN = /^ {0,3}(`{3,}(?![^`\n]*`)|~{3,})/;
// After a blank line these still continue the previous block: a list item or indented content.
const CONTINUATION_PATTERN = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;
// Claude insight fences render as one callout, so they stay in one block until the closing rule.
const INSIGHT_OPEN_PATTERN = /^( {0,3})(`?)★ Insight[ \t]+─{3,}\2[ \t]*$/u;
const INSIGHT_CLOSE_PATTERN = /^( {0,3})(`?)─{3,}\2[ \t]*$/u;
// An ATX heading, also inside a list item or blockquote; group 1 is its text.
const ATX_HEADING_PATTERN =
  /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
// Setext headings may span a paragraph and containers, so leave their parsing to the renderer.
const SETEXT_UNDERLINE_PATTERN =
  /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*(?:=+|-+)[ \t]*$/;

// Inline syntax that cannot be slugged reliably without the full Markdown renderer.
const AMBIGUOUS_HEADING_SYNTAX =
  /[~[\]<&\\!$]|:(?:codex-file-citation|codex-followup|artifact-template)\b|mailto:/i;
// Non-intraword underscores can act as emphasis delimiters and disappear from the heading's slug.
const BOUNDARY_UNDERSCORE = /(?:^|[^\p{L}\p{N}])_|_(?:[^\p{L}\p{N}]|$)/u;

function stripHeadingInlineCode(text: string): {
  readonly plain: string;
  readonly outsideCode: string;
} {
  if (!text.includes("`")) {
    return { plain: text, outsideCode: text };
  }
  let plain = "";
  let outsideCode = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`") {
      const nextTick = text.indexOf("`", index);
      const chunk = nextTick === -1 ? text.slice(index) : text.slice(index, nextTick);
      plain += chunk;
      outsideCode += chunk;
      if (nextTick === -1) break;
      index = nextTick;
      continue;
    }
    let ticks = 0;
    while (index + ticks < text.length && text[index + ticks] === "`") ticks += 1;
    let search = index + ticks;
    let closeAt = -1;
    while (search < text.length) {
      const candidate = text.indexOf("`", search);
      if (candidate === -1) break;
      let run = 0;
      while (candidate + run < text.length && text[candidate + run] === "`") run += 1;
      if (run === ticks) {
        closeAt = candidate;
        break;
      }
      search = candidate + run;
    }
    if (closeAt === -1) {
      const literal = text.slice(index, index + ticks);
      plain += literal;
      outsideCode += literal;
      index += ticks;
      continue;
    }
    let inner = text.slice(index + ticks, closeAt);
    if (inner.length >= 2 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "") {
      inner = inner.slice(1, -1);
    }
    plain += inner;
    index = closeAt + ticks;
  }
  return { plain, outsideCode };
}

interface HeadingSlugTracker {
  headingCount: number;
  hasAmbiguousHeading: boolean;
  readonly headingKeys: Set<string>;
  readonly looseHeadingKeys: Set<string>;
  readonly fuzzyHeadingKeys: Set<string>;
}

function cloneHeadingTracker(tracker: HeadingSlugTracker): HeadingSlugTracker {
  return {
    headingCount: tracker.headingCount,
    hasAmbiguousHeading: tracker.hasAmbiguousHeading,
    headingKeys: new Set(tracker.headingKeys),
    looseHeadingKeys: new Set(tracker.looseHeadingKeys),
    fuzzyHeadingKeys: new Set(tracker.fuzzyHeadingKeys),
  };
}

function recordHeadingNeedsWholeDocument(
  tracker: HeadingSlugTracker,
  line: string,
  mayUnderline: boolean,
): boolean {
  const isSetext = mayUnderline && SETEXT_UNDERLINE_PATTERN.test(line);
  const headingText = isSetext ? undefined : ATX_HEADING_PATTERN.exec(line)?.[1];
  if (!isSetext && headingText === undefined) return false;

  if (isSetext) {
    if (tracker.headingCount > 0) return true;
    tracker.hasAmbiguousHeading = true;
    tracker.headingCount += 1;
    return false;
  }

  const { plain, outsideCode } = stripHeadingInlineCode(headingText!);
  if (AMBIGUOUS_HEADING_SYNTAX.test(outsideCode)) {
    if (tracker.headingCount > 0) return true;
    tracker.hasAmbiguousHeading = true;
    tracker.headingCount += 1;
    return false;
  }
  if (tracker.hasAmbiguousHeading) return true;

  const key = githubHeadingSlug(plain);
  if (!key) return false;
  const looseKey = key.replaceAll("_", "");
  const hasBoundaryUnderscore = BOUNDARY_UNDERSCORE.test(outsideCode);
  if (
    tracker.headingKeys.has(key) ||
    (hasBoundaryUnderscore
      ? tracker.looseHeadingKeys.has(looseKey)
      : tracker.fuzzyHeadingKeys.has(looseKey))
  ) {
    return true;
  }
  tracker.headingKeys.add(key);
  tracker.looseHeadingKeys.add(looseKey);
  if (hasBoundaryUnderscore) tracker.fuzzyHeadingKeys.add(looseKey);
  tracker.headingCount += 1;
  return false;
}

interface CachedStreamBlocks {
  readonly lastText: string;
  readonly lastResult: string[] | null;
  readonly finalizedBlocks: readonly string[];
  readonly finalizedLength: number;
  readonly finalizedPrefix: string;
  readonly finalizedHeadings: HeadingSlugTracker;
}

const MAX_STREAM_BLOCK_CACHE_ENTRIES = 64;
const streamBlockCache = new Map<string, CachedStreamBlocks>();

function saveStreamBlockCache(key: string, entry: CachedStreamBlocks): void {
  streamBlockCache.delete(key);
  streamBlockCache.set(key, entry);
  if (streamBlockCache.size > MAX_STREAM_BLOCK_CACHE_ENTRIES) {
    const oldest = streamBlockCache.keys().next().value;
    if (oldest !== undefined) streamBlockCache.delete(oldest);
  }
}

/**
 * Cuts Markdown at blank lines that close every open block, so each piece renders exactly as it
 * would inside the whole text. Returns null when the text uses syntax that spans blocks, such as
 * headings with the same slug, whose ids are numbered across the whole text.
 */
export function splitMarkdownBlocks(text: string, cacheKey?: string): string[] | null {
  const key = cacheKey ?? text.slice(0, 64);
  const cached = streamBlockCache.get(key);
  if (cached !== undefined && cached.lastText === text) {
    streamBlockCache.delete(key);
    streamBlockCache.set(key, cached);
    return cached.lastResult;
  }

  // remark-parse strips a leading BOM before recognizing the first heading.
  if (text.startsWith("\ufeff")) {
    return null;
  }

  let startOffset = 0;
  let blocks: string[] = [];
  let headings: HeadingSlugTracker = {
    headingCount: 0,
    hasAmbiguousHeading: false,
    headingKeys: new Set(),
    looseHeadingKeys: new Set(),
    fuzzyHeadingKeys: new Set(),
  };

  if (
    cached !== undefined &&
    cached.finalizedLength > 0 &&
    text.length >= cached.finalizedLength &&
    text.startsWith(cached.finalizedPrefix)
  ) {
    const firstTailNewline = text.indexOf("\n", cached.finalizedLength);
    const firstTailLine = text.slice(
      cached.finalizedLength,
      firstTailNewline === -1 ? text.length : firstTailNewline,
    );
    // An incomplete line like "1" can turn into "1." (a list continuation) on the next token.
    if (!CONTINUATION_PATTERN.test(firstTailLine)) {
      startOffset = cached.finalizedLength;
      blocks = cached.finalizedBlocks.slice();
      headings = cloneHeadingTracker(cached.finalizedHeadings);
    }
  }

  const scanSource = startOffset === 0 ? text : text.slice(startOffset);
  if (scanSource.includes("\r") || DOCUMENT_WIDE_SYNTAX.test(scanSource)) {
    saveStreamBlockCache(key, {
      lastText: text,
      lastResult: null,
      finalizedBlocks: startOffset > 0 ? cached!.finalizedBlocks : [],
      finalizedLength: startOffset,
      finalizedPrefix: startOffset > 0 ? cached!.finalizedPrefix : "",
      finalizedHeadings: startOffset > 0 ? cached!.finalizedHeadings : headings,
    });
    return null;
  }

  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let afterBlankLine = false;
  let insightIndent: string | null = null;
  // Only a line right after paragraph text can underline it; elsewhere "---" is a thematic break.
  let afterContentLine = false;
  let finalizedBlockCount = blocks.length;
  let finalizedLength = startOffset;
  let finalizedHeadings = cloneHeadingTracker(headings);

  for (const line of scanSource.split("\n")) {
    const opener = FENCE_PATTERN.exec(line)?.[1];
    const mayUnderline = afterContentLine;
    afterContentLine = false;
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which isn't tracked.
      if (/\S/.test(line.slice(0, fenceIndent))) {
        const rest = scanSource.slice(lineStart).split("\n");
        for (const restLine of rest) {
          if (recordHeadingNeedsWholeDocument(headings, restLine, true)) {
            saveStreamBlockCache(key, {
              lastText: text,
              lastResult: null,
              finalizedBlocks: blocks.slice(0, finalizedBlockCount),
              finalizedLength,
              finalizedPrefix: finalizedLength > 0 ? text.slice(0, finalizedLength) : "",
              finalizedHeadings,
            });
            return null;
          }
        }
        break;
      }
      if (
        opener &&
        opener[0] === fence[0] &&
        opener.length >= fence.length &&
        line.trim() === opener
      ) {
        fence = null;
      }
    } else if (insightIndent !== null && INSIGHT_CLOSE_PATTERN.exec(line)?.[1] === insightIndent) {
      insightIndent = null;
      afterBlankLine = false;
    } else if (line.trim() === "") {
      afterBlankLine = true;
    } else {
      if (
        afterBlankLine &&
        insightIndent === null &&
        lineStart > blockStart &&
        !CONTINUATION_PATTERN.test(line)
      ) {
        blocks.push(scanSource.slice(blockStart, lineStart));
        blockStart = lineStart;
        finalizedBlockCount = blocks.length;
        finalizedLength = startOffset + lineStart;
        finalizedHeadings = cloneHeadingTracker(headings);
      }
      if (recordHeadingNeedsWholeDocument(headings, line, mayUnderline)) {
        saveStreamBlockCache(key, {
          lastText: text,
          lastResult: null,
          finalizedBlocks: blocks.slice(0, finalizedBlockCount),
          finalizedLength,
          finalizedPrefix: finalizedLength > 0 ? text.slice(0, finalizedLength) : "",
          finalizedHeadings,
        });
        return null;
      }
      afterContentLine = opener === undefined;
      afterBlankLine = false;
      if (insightIndent === null) insightIndent = INSIGHT_OPEN_PATTERN.exec(line)?.[1] ?? null;
      fence = opener ?? null;
      if (opener) fenceIndent = line.indexOf(opener);
    }
    lineStart += line.length + 1;
  }
  blocks.push(scanSource.slice(blockStart));
  saveStreamBlockCache(key, {
    lastText: text,
    lastResult: blocks,
    finalizedBlocks: blocks.slice(0, finalizedBlockCount),
    finalizedLength,
    finalizedPrefix: finalizedLength > 0 ? text.slice(0, finalizedLength) : "",
    finalizedHeadings,
  });
  return blocks;
}
