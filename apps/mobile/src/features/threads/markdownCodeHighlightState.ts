import { useEffect, useMemo, useState } from "react";

import { resolveHighlightLanguage } from "../../lib/highlightLanguage";
import {
  hasAsyncNativeHighlights,
  highlightCode,
  tokenizeCodeAsync,
  type HighlightedLines,
  type HighlightScheme,
} from "../../lib/highlights";

const ASYNC_MARKDOWN_HIGHLIGHT_THRESHOLD_CHARS = 4_000;

export function useMarkdownCodeHighlight(input: {
  readonly code: string;
  readonly enabled: boolean;
  readonly language: string | null | undefined;
  readonly theme: HighlightScheme;
}): HighlightedLines | null {
  const { code, enabled, theme } = input;
  const language = input.language?.trim();
  const resolvedLanguage = language ? resolveHighlightLanguage({ language }) : null;
  const deferHighlight =
    enabled && resolvedLanguage !== null && code.length > ASYNC_MARKDOWN_HIGHLIGHT_THRESHOLD_CHARS;

  const syncLines = useMemo(
    () =>
      enabled && resolvedLanguage !== null && !deferHighlight
        ? highlightCode(code, resolvedLanguage, theme)
        : null,
    [code, deferHighlight, enabled, resolvedLanguage, theme],
  );

  const [asyncResult, setAsyncResult] = useState<{
    readonly code: string;
    readonly language: string;
    readonly theme: HighlightScheme;
    readonly lines: HighlightedLines;
  } | null>(null);

  // oxlint-disable-next-line zerocode/no-unreasoned-state-sync -- offloads large code-fence tokenization to the async highlighter so scrolling never stalls
  useEffect(() => {
    if (!deferHighlight || resolvedLanguage === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      void tokenizeCodeAsync(code, resolvedLanguage).then((tokenized) => {
        if (cancelled) return;
        const lines = Array.from({ length: tokenized.lineCount }, (_, index) =>
          tokenized.highlightLine(index, theme)!,
        );
        setAsyncResult({ code, language: resolvedLanguage, theme, lines });
      });
    };
    if (hasAsyncNativeHighlights()) {
      run();
    } else {
      timer = setTimeout(run, 0);
    }
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [code, deferHighlight, resolvedLanguage, theme]);

  if (!deferHighlight) return syncLines;
  if (
    asyncResult !== null &&
    asyncResult.code === code &&
    asyncResult.language === resolvedLanguage &&
    asyncResult.theme === theme
  ) {
    return asyncResult.lines;
  }
  return null;
}
