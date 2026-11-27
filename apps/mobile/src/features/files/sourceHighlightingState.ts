import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { resolveHighlightLanguage } from "../../lib/highlightLanguage";
import {
  hasAsyncNativeHighlights,
  tokenizeCodeAsync,
  type TokenizedCode,
} from "../../lib/highlights";

const SOURCE_HIGHLIGHT_IDLE_TTL_MS = 5 * 60_000;
const DEFER_SYNC_HIGHLIGHT_THRESHOLD_CHARS = 8_000;

export interface SourceHighlightInput {
  readonly path: string;
  readonly contents: string;
}

class SourceHighlightCacheKey extends Data.Class<SourceHighlightInput> {}

class SourceHighlightError extends Schema.TaggedError<SourceHighlightError>()(
  "SourceHighlightError",
  { cause: Schema.Defect() },
) {}

// Retain compact theme-independent native token records and unpack lines lazily on viewport demand.
const sourceHighlightFamily = Atom.family((request: SourceHighlightCacheKey) =>
  Atom.make(
    Effect.tryPromise({
      try: async (): Promise<TokenizedCode> => {
        if (
          !hasAsyncNativeHighlights() &&
          request.contents.length > DEFER_SYNC_HIGHLIGHT_THRESHOLD_CHARS
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        return tokenizeCodeAsync(
          request.contents,
          resolveHighlightLanguage({ path: request.path }),
        );
      },
      catch: (cause) => new SourceHighlightError({ cause }),
    }),
  ).pipe(
    Atom.setIdleTTL(SOURCE_HIGHLIGHT_IDLE_TTL_MS),
    Atom.withLabel(`mobile:source-highlight:${request.path}`),
  ),
);

export const sourceHighlightAtom = (input: SourceHighlightInput) =>
  sourceHighlightFamily(new SourceHighlightCacheKey(input));
