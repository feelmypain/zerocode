import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProviderReplayEntry = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("expect_outbound"),
    label: Schema.optional(TrimmedNonEmptyString),
    frame: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("emit_inbound"),
    label: Schema.optional(TrimmedNonEmptyString),
    frame: Schema.Unknown,
    afterMs: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    type: Schema.Literal("runtime_exit"),
    status: Schema.Literals(["success", "error", "cancelled"]),
    error: Schema.optional(Schema.Unknown),
  }),
]);
export type ProviderReplayEntry = typeof ProviderReplayEntry.Type;

export const ProviderReplayTranscript = Schema.Struct({
  provider: TrimmedNonEmptyString,
  protocol: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  scenario: TrimmedNonEmptyString,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
export type ProviderReplayTranscript = typeof ProviderReplayTranscript.Type;
