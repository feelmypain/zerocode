import { displayWidth, wrapAnsiText, wrapPlainText } from "./terminal.ts";
import type { ResolvedTuiTheme } from "./themes.ts";

const CODE_KEYWORDS = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "elif",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "fn",
  "for",
  "from",
  "func",
  "function",
  "if",
  "impl",
  "import",
  "in",
  "interface",
  "let",
  "match",
  "mod",
  "mut",
  "new",
  "null",
  "package",
  "pub",
  "return",
  "self",
  "static",
  "struct",
  "switch",
  "throw",
  "trait",
  "true",
  "try",
  "type",
  "undefined",
  "use",
  "var",
  "void",
  "where",
  "while",
  "yield",
]);

function highlightCodeLine(line: string, lang: string, theme: ResolvedTuiTheme): string {
  if (theme.depth === "none") return line;
  const trimmed = line.trimStart();
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("--") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*")
  ) {
    return theme.dimText(line);
  }
  if (lang === "diff" || lang === "patch") {
    if (line.startsWith("+++") || line.startsWith("---")) return theme.bold("muted", line);
    if (line.startsWith("+")) return theme.fg("diffAdd", line);
    if (line.startsWith("-")) return theme.fg("diffDel", line);
    if (line.startsWith("@@")) return theme.fg("accent", line);
  }
  const tokenRe =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*$|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/gu;
  let result = "";
  let lastIndex = 0;
  for (const match of line.matchAll(tokenRe)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      result += theme.fg("code", line.slice(lastIndex, idx));
    }
    const token = match[0];
    if (token.startsWith("//")) {
      result += theme.dimText(token);
    } else if (token.startsWith('"') || token.startsWith("'") || token.startsWith("`")) {
      result += theme.fg("toolOk", token);
    } else if (/^\d/.test(token)) {
      result += theme.fg("warning", token);
    } else if (CODE_KEYWORDS.has(token)) {
      result += theme.bold("accent", token);
    } else if (/^[A-Z][A-Za-z0-9_]*$/.test(token)) {
      result += theme.fg("assistantLabel", token);
    } else {
      result += theme.fg("code", token);
    }
    lastIndex = idx + token.length;
  }
  if (lastIndex < line.length) {
    result += theme.fg("code", line.slice(lastIndex));
  }
  return result;
}

function renderInlineMarkdown(line: string, theme: ResolvedTuiTheme): string {
  if (theme.depth === "none") return line;
  const inlineRe =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|\[([^\]]+)\]\(([^)]+)\))/gu;
  let out = "";
  let lastIndex = 0;
  for (const match of line.matchAll(inlineRe)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      out += theme.fg("text", line.slice(lastIndex, idx));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      const inner = token.slice(1, -1);
      out += theme.bg("codeBg", theme.fg("accent", ` ${inner} `));
    } else if (token.startsWith("**") || token.startsWith("__")) {
      out += theme.bold("text", token.slice(2, -2));
    } else if (token.startsWith("~~")) {
      out += theme.dimText(token.slice(2, -2));
    } else if (token.startsWith("*")) {
      out += theme.italic("text", token.slice(1, -1));
    } else if (token.startsWith("[")) {
      const label = match[2] ?? token;
      const href = match[3] ?? "";
      out += `${theme.bold("accent", label)} ${theme.dimText(`(${href})`)}`;
    }
    lastIndex = idx + token.length;
  }
  if (lastIndex < line.length) {
    out += theme.fg("text", line.slice(lastIndex));
  }
  return out;
}

/** Renders Markdown content into terminal-ready ANSI lines constrained to `maxWidth` columns. */
export function renderMarkdown(
  markdown: string,
  maxWidth: number,
  theme: ResolvedTuiTheme,
): Array<string> {
  const width = Math.max(20, maxWidth);
  const rawLines = markdown.replaceAll("\r\n", "\n").split("\n");
  const output: Array<string> = [];

  let inFence = false;
  let fenceLang = "";

  for (const rawLine of rawLines) {
    const fenceMatch = /^```([^\s`]*)\s*$/.exec(rawLine.trim());
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLang = (fenceMatch[1] ?? "").toLowerCase();
        const label = fenceLang ? ` ${fenceLang} ` : "";
        const ruleLen = Math.max(0, width - 3 - displayWidth(label));
        output.push(
          theme.fg("border", `${theme.border.tl}${theme.border.h}`) +
            (label ? theme.bold("accent", label) : "") +
            theme.fg("border", theme.border.h.repeat(ruleLen)),
        );
      } else {
        inFence = false;
        fenceLang = "";
        output.push(
          theme.fg("border", `${theme.border.bl}${theme.border.h.repeat(Math.max(0, width - 2))}`),
        );
      }
      continue;
    }

    if (inFence) {
      const codeWidth = Math.max(10, width - 3);
      const wrapped = wrapPlainText(rawLine, codeWidth);
      for (const piece of wrapped) {
        output.push(
          `${theme.fg("border", theme.border.v)} ${highlightCodeLine(piece, fenceLang, theme)}`,
        );
      }
      continue;
    }

    if (rawLine.trim().length === 0) {
      output.push("");
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|===+|\*\*\*+)\s*$/.test(rawLine)) {
      output.push(theme.fg("border", theme.border.sep.repeat(Math.min(width, 60))));
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(rawLine);
    if (headingMatch?.[1] && headingMatch[2] !== undefined) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const prefix = level === 1 ? "▍ " : level === 2 ? "▎ " : "· ";
      const wrapped = wrapPlainText(text, Math.max(10, width - 2));
      for (const piece of wrapped) {
        output.push(
          level <= 2
            ? theme.bold("accent", `${prefix}${piece}`)
            : theme.bold("assistantLabel", `${prefix}${piece}`),
        );
      }
      continue;
    }

    // Blockquote
    const quoteMatch = /^\s*>\s?(.*)$/.exec(rawLine);
    if (quoteMatch && quoteMatch[1] !== undefined) {
      const wrapped = wrapAnsiText(
        renderInlineMarkdown(quoteMatch[1], theme),
        Math.max(10, width - 3),
      );
      for (const piece of wrapped) {
        output.push(`${theme.fg("accent", theme.border.rail)} ${piece}`);
      }
      continue;
    }

    // Bullet / task list item
    const bulletMatch = /^(\s*)([-*+])\s+(.*)$/.exec(rawLine);
    if (bulletMatch?.[1] !== undefined && bulletMatch[3] !== undefined) {
      const indent = " ".repeat(Math.min(8, bulletMatch[1].length));
      let content = bulletMatch[3];
      let bullet = theme.fg("accent", "•");
      if (content.startsWith("[x] ") || content.startsWith("[X] ")) {
        bullet = theme.fg("toolOk", "✓");
        content = content.slice(4);
      } else if (content.startsWith("[ ] ")) {
        bullet = theme.fg("muted", "○");
        content = content.slice(4);
      }
      const prefixWidth = indent.length + 2;
      const wrapped = wrapAnsiText(
        renderInlineMarkdown(content, theme),
        Math.max(10, width - prefixWidth),
      );
      wrapped.forEach((piece, idx) => {
        output.push(idx === 0 ? `${indent}${bullet} ${piece}` : `${indent}  ${piece}`);
      });
      continue;
    }

    // Ordered list item
    const orderedMatch = /^(\s*)(\d+\.)\s+(.*)$/.exec(rawLine);
    if (orderedMatch?.[1] !== undefined && orderedMatch[2] && orderedMatch[3] !== undefined) {
      const indent = " ".repeat(Math.min(8, orderedMatch[1].length));
      const marker = orderedMatch[2];
      const prefixWidth = indent.length + marker.length + 1;
      const wrapped = wrapAnsiText(
        renderInlineMarkdown(orderedMatch[3], theme),
        Math.max(10, width - prefixWidth),
      );
      wrapped.forEach((piece, idx) => {
        output.push(
          idx === 0
            ? `${indent}${theme.fg("accent", marker)} ${piece}`
            : `${indent}${" ".repeat(marker.length + 1)}${piece}`,
        );
      });
      continue;
    }

    // Markdown table row
    if (rawLine.trim().startsWith("|") && rawLine.trim().endsWith("|")) {
      if (/^\|[\s:|-]+\|$/.test(rawLine.trim())) {
        output.push(
          theme.fg("border", theme.border.sep.repeat(Math.min(width, displayWidth(rawLine)))),
        );
      } else {
        const styled = rawLine
          .split("|")
          .map((cell) => renderInlineMarkdown(cell, theme))
          .join(theme.fg("border", "│"));
        output.push(...wrapAnsiText(styled, width));
      }
      continue;
    }

    // Normal paragraph line
    output.push(...wrapAnsiText(renderInlineMarkdown(rawLine, theme), width));
  }

  return output;
}

/** Renders a unified diff snippet colorized by the active theme. */
export function renderDiffSnippet(
  diffText: string,
  maxWidth: number,
  theme: ResolvedTuiTheme,
  maxLines = 40,
): Array<string> {
  const lines = diffText.replaceAll("\r\n", "\n").split("\n");
  const slice = lines.slice(0, maxLines);
  const out: Array<string> = [];
  for (const line of slice) {
    for (const wrapped of wrapPlainText(line, Math.max(12, maxWidth))) {
      if (wrapped.startsWith("+++") || wrapped.startsWith("---")) {
        out.push(theme.bold("muted", wrapped));
      } else if (wrapped.startsWith("@@")) {
        out.push(theme.fg("accent", wrapped));
      } else if (wrapped.startsWith("+")) {
        out.push(theme.fg("diffAdd", wrapped));
      } else if (wrapped.startsWith("-")) {
        out.push(theme.fg("diffDel", wrapped));
      } else {
        out.push(theme.dimText(wrapped));
      }
    }
  }
  if (lines.length > maxLines) {
    out.push(
      theme.dimText(`… ${lines.length - maxLines} more diff line(s) (/diff to inspect full diff)`),
    );
  }
  return out;
}
