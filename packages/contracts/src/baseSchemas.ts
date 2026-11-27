import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaTransformation from "effect/SchemaTransformation";

// Hermes copies the string on every `trim()`, even when nothing changes.
// Returning the original keeps repeated IDs shared after decode.
const trim = (value: string) => {
  const len = value.length;
  if (len === 0) return value;
  const first = value.charCodeAt(0);
  const last = value.charCodeAt(len - 1);
  if (first > 0x20 && first < 0xa0 && last > 0x20 && last < 0xa0) {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === len ? value : trimmed;
};

export const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: trim,
      encode: trim,
    }),
  ),
);

const hasNonWhitespace = (value: string): boolean => {
  const len = value.length;
  if (len === 0) return false;
  const first = value.charCodeAt(0);
  if (first > 0x20 && first < 0xa0) return true;
  const last = value.charCodeAt(len - 1);
  if (last > 0x20 && last < 0xa0) return true;
  return value.trim().length > 0;
};
// `make` and encode see untrimmed values; `isNonEmpty` would accept whitespace that encodes to an invalid empty string.
const isNonBlank = Schema.makeFilter(hasNonWhitespace, {
  expected: "a non-blank string",
  toJsonSchema: () => [{ minLength: 1 }, true],
  arbitraryConstraint: { minLength: 1 },
});
export const TrimmedNonEmptyString = TrimmedString.check(isNonBlank);

// Git forbids ASCII space and control characters in ref names but allows Unicode whitespace such
// as U+00A0 and U+3000, which `String.prototype.trim` would strip from a name's edges.
export function trimAsciiWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isAsciiWhitespace(value.charCodeAt(start))) start++;
  while (end > start && isAsciiWhitespace(value.charCodeAt(end - 1))) end--;
  return end - start === value.length ? value : value.slice(start, end);
}

function isAsciiWhitespace(code: number): boolean {
  return code <= 0x20 && (code === 0x20 || (code >= 0x09 && code <= 0x0d));
}

const hasNonAsciiWhitespace = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    if (!isAsciiWhitespace(value.charCodeAt(i))) return true;
  }
  return false;
};

const isNonBlankGitRefName = Schema.makeFilter(hasNonAsciiWhitespace, {
  expected: "a non-blank string",
  toJsonSchema: () => [{ minLength: 1 }, true],
  arbitraryConstraint: { minLength: 1 },
});
/** A branch, ref or remote name. Unlike `TrimmedNonEmptyString`, it keeps Unicode whitespace. */
export const GitRefName = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: trimAsciiWhitespace,
      encode: trimAsciiWhitespace,
    }),
  ),
).check(isNonBlankGitRefName);

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

export const DpopFailureReason = Schema.Literals([
  "time_window",
  "key_mismatch",
  "request_mismatch",
  "token_mismatch",
  "replay",
  "invalid_proof",
]);
export type DpopFailureReason = typeof DpopFailureReason.Type;

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

const UnknownAsMissing = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Undefined, {
    decode: SchemaGetter.omit(),
    encode: SchemaGetter.omit(),
  }),
);

const UnknownAsNull = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Null, {
    decode: SchemaGetter.succeed(null),
    encode: SchemaGetter.passthrough(),
  }),
);

export const ForwardCompatibleOptional = <Value extends Schema.Top>(value: Value) =>
  // Unreadable values drop the key: an own undefined property is not JSON and fails RPC encoding.
  Schema.optionalKey(Schema.Union([value, UnknownAsMissing]));

export const ForwardCompatibleNullable = <Value extends Schema.Top>(value: Value) =>
  Schema.Union([value, UnknownAsNull]);

/** Missing or unknown values decode to null; null encodes as absent for older clients requiring a literal. */
export const OmittedWhenNull = <Value extends Schema.Top>(value: Value) =>
  Schema.optionalKey(Schema.Unknown).pipe(
    Schema.decodeTo(
      ForwardCompatibleNullable(value),
      SchemaTransformation.transformOptional<unknown, unknown>({
        decode: (raw) => (Option.isSome(raw) ? raw : Option.some(null)),
        encode: (raw) => (Option.isSome(raw) && raw.value !== null ? raw : Option.none()),
      }),
    ),
  );

const UnknownArrayElement = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Undefined, {
    decode: SchemaGetter.succeed(undefined),
    encode: SchemaGetter.passthrough(),
  }),
);

/** Prefer {@link ForwardCompatibleUnion} for tagged unions so malformed known members still fail. */
export const ForwardCompatibleArray = <Element extends Schema.Top>(element: Element) =>
  // Exit derives its wire codec from the encoded shape, which keeps the union but drops recovery middleware.
  Schema.Array(
    Schema.Union([element, UnknownArrayElement]).pipe(
      Schema.catchEncoding(() => Effect.succeedSome(undefined)),
    ),
  ).pipe(
    Schema.decodeTo(
      Schema.Array(
        Schema.UndefinedOr(Schema.toType(element)).pipe(
          Schema.catchEncoding(() => Effect.succeedSome(undefined)),
        ),
      ).check(
        // Schema.is/make must reject holes; abort before later array checks.
        Schema.makeFilter(
          (values) => {
            // Every index, not `every`, which skips the holes of a sparse array.
            for (let index = 0; index < values.length; index++) {
              if (values[index] === undefined) return false;
            }
            return true;
          },
          { expected: "an array without holes" },
          true,
        ),
      ),
      SchemaTransformation.transform<
        ReadonlyArray<Element["Type"]>,
        ReadonlyArray<Element["Type"] | undefined>
      >({
        decode: (values) => values.filter((value) => value !== undefined),
        encode: (values) => values.filter((value) => value !== undefined),
      }),
    ),
  ) as unknown as ForwardCompatibleArray<Element>;
export type ForwardCompatibleArray<Element extends Schema.Top> = Schema.Codec<
  ReadonlyArray<Element["Type"]>,
  ReadonlyArray<Element["Encoded"]>,
  Element["DecodingServices"],
  Element["EncodingServices"]
>;

/** Class identity prevents decoded payloads from impersonating unknown members. */
export class UnknownUnionMember<Tag extends string = string> {
  readonly tag: Tag;
  readonly value: string;
  constructor(tag: Tag, value: string) {
    this.tag = tag;
    this.value = value;
  }
}

/** Unknown members are decode-only; encoding one fails. */
export const ForwardCompatibleUnion = <
  const Members extends ReadonlyArray<Schema.Top & { readonly fields: object }>,
  const Tag extends string,
>(
  members: Members,
  tag: Tag,
) => {
  const known = knownTags(members, tag);
  const unknownMember = Schema.Struct({
    [tag]: Schema.String.check(
      Schema.makeFilter(
        (value: string) => !known.has(value) || `A known ${tag} must decode in full.`,
      ),
    ),
  } as Record<Tag, Schema.String>).pipe(
    Schema.decodeTo(Schema.instanceOf(UnknownUnionMember<Tag>), {
      decode: SchemaGetter.transform(
        (raw: Record<string, string>) => new UnknownUnionMember(tag, raw[tag]!),
      ),
      encode: SchemaGetter.forbidden(() => `Unknown ${tag} values are never sent.`),
    }),
  );
  return Schema.Union([...members, unknownMember]) as unknown as ForwardCompatibleUnion<
    Members,
    Tag
  >;
};
export type ForwardCompatibleUnion<
  Members extends ReadonlyArray<Schema.Top>,
  Tag extends string,
> = Schema.Codec<
  Members[number]["Type"] | UnknownUnionMember<Tag>,
  Members[number]["Encoded"],
  Members[number]["DecodingServices"],
  Members[number]["EncodingServices"]
>;

export const hasUnknownUnionTag = (
  members: ReadonlyArray<Schema.Top & { readonly fields: object }>,
  tag: string,
): ((value: unknown) => boolean) => {
  const known = knownTags(members, tag);
  return (value) =>
    typeof value === "object" &&
    value !== null &&
    tag in value &&
    !known.has((value as Record<string, unknown>)[tag] as string);
};

export const isUnknownUnionMember = <A>(
  value: A,
): value is Extract<A, UnknownUnionMember<string>> => value instanceof UnknownUnionMember;

// `ForwardCompatibleUnion` already validated every kept element; a full array target re-runs the union.
const ValidatedArray = Schema.declare(
  (value: unknown): value is ReadonlyArray<unknown> => Array.isArray(value),
  { expected: "an array" },
);

const compactUnknown = <A>(
  values: ReadonlyArray<A>,
  isUnknown: (value: A) => boolean,
): ReadonlyArray<A> => {
  for (let i = 0; i < values.length; i++) {
    if (isUnknown(values[i]!)) {
      const kept = values.slice(0, i);
      for (let j = i + 1; j < values.length; j++) {
        const value = values[j]!;
        if (!isUnknown(value)) kept.push(value);
      }
      return kept;
    }
  }
  return values;
};

export const ForwardCompatibleUnionArray = <
  const Members extends ReadonlyArray<Schema.Top & { readonly fields: object }>,
  const Tag extends string,
>(
  members: Members,
  tag: Tag,
) =>
  Schema.Array(ForwardCompatibleUnion(members, tag)).pipe(
    Schema.decodeTo(
      ValidatedArray,
      SchemaTransformation.transform<
        ReadonlyArray<unknown>,
        ReadonlyArray<Members[number]["Type"] | UnknownUnionMember<Tag>>
      >({
        decode: (values) => compactUnknown(values, isUnknownUnionMember),
        encode: (values) => values as ReadonlyArray<Members[number]["Type"]>,
      }),
    ),
  ) as unknown as ForwardCompatibleUnionArray<Members>;
export type ForwardCompatibleUnionArray<Members extends ReadonlyArray<Schema.Top>> = Schema.Codec<
  ReadonlyArray<Members[number]["Type"]>,
  ReadonlyArray<Members[number]["Encoded"]>,
  Members[number]["DecodingServices"],
  Members[number]["EncodingServices"]
>;

const knownTags = (
  members: ReadonlyArray<Schema.Top & { readonly fields: object }>,
  tag: string,
): ReadonlySet<string> => {
  const tags = new Set<string>();
  for (const member of members) {
    const field = (member.fields as Record<string, unknown>)[tag] as
      | { readonly literal?: unknown; readonly literals?: ReadonlyArray<unknown> }
      | undefined;
    for (const literal of field?.literals ?? [field?.literal]) {
      if (typeof literal !== "string") {
        throw new Error(`Every ForwardCompatibleUnion member needs a string literal ${tag}.`);
      }
      tags.add(literal);
    }
  }
  return tags;
};

const makeEntityId = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) => {
  return TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));
};

export const ThreadId = makeEntityId("ThreadId");
export type ThreadId = typeof ThreadId.Type;
export const ProjectId = makeEntityId("ProjectId");
export type ProjectId = typeof ProjectId.Type;
export const EnvironmentId = makeEntityId("EnvironmentId");
export type EnvironmentId = typeof EnvironmentId.Type;
export const CommandId = makeEntityId("CommandId");
export type CommandId = typeof CommandId.Type;
export const EventId = makeEntityId("EventId");
export type EventId = typeof EventId.Type;
export const MessageId = makeEntityId("MessageId");
export type MessageId = typeof MessageId.Type;
export const TurnId = makeEntityId("TurnId");
export type TurnId = typeof TurnId.Type;
export const RunId = makeEntityId("RunId");
export type RunId = typeof RunId.Type;
export const RunAttemptId = makeEntityId("RunAttemptId");
export type RunAttemptId = typeof RunAttemptId.Type;
export const NodeId = makeEntityId("NodeId");
export type NodeId = typeof NodeId.Type;
export const GuestShareId = makeEntityId("GuestShareId");
export type GuestShareId = typeof GuestShareId.Type;
export const GuestMessageId = makeEntityId("GuestMessageId");
export type GuestMessageId = typeof GuestMessageId.Type;
export const AuthSessionId = makeEntityId("AuthSessionId");
export type AuthSessionId = typeof AuthSessionId.Type;
export const RpcClientId = NonNegativeInt.pipe(Schema.brand("RpcClientId"));
export type RpcClientId = typeof RpcClientId.Type;

export const ClientSurface = Schema.Literals(["web", "desktop", "mobile", "cli"]);
export type ClientSurface = typeof ClientSurface.Type;

export const ClientOs = Schema.Literals([
  "macOS",
  "Windows",
  "Linux",
  "iOS",
  "Android",
  "ChromeOS",
  "other",
  "unknown",
]);
export type ClientOs = typeof ClientOs.Type;

export const ClientDeviceType = Schema.Literals(["desktop", "phone", "tablet", "unknown"]);
export type ClientDeviceType = typeof ClientDeviceType.Type;

export const ClientWebDeployment = Schema.Literals(["hosted", "server"]);
export type ClientWebDeployment = typeof ClientWebDeployment.Type;

export const ClientConnectionMethod = Schema.Literals(["direct", "ssh", "relay", "unknown"]);
export type ClientConnectionMethod = typeof ClientConnectionMethod.Type;

export const ProviderItemId = makeEntityId("ProviderItemId");
export type ProviderItemId = typeof ProviderItemId.Type;
export const ProviderSessionId = makeEntityId("ProviderSessionId");
export type ProviderSessionId = typeof ProviderSessionId.Type;
export const ProviderThreadId = makeEntityId("ProviderThreadId");
export type ProviderThreadId = typeof ProviderThreadId.Type;
export const ProviderTurnId = makeEntityId("ProviderTurnId");
export type ProviderTurnId = typeof ProviderTurnId.Type;
export const TurnItemId = makeEntityId("TurnItemId");
export type TurnItemId = typeof TurnItemId.Type;
export const RuntimeRequestId = makeEntityId("RuntimeRequestId");
export type RuntimeRequestId = typeof RuntimeRequestId.Type;
export const ScheduledTaskId = makeEntityId("ScheduledTaskId");
/** A one-use handle to a secret the user entered for an agent; the agent never sees the value. */
export const SecretRef = makeEntityId("SecretRef");
export type SecretRef = typeof SecretRef.Type;
export type ScheduledTaskId = typeof ScheduledTaskId.Type;
export const ApprovalRequestId = makeEntityId("ApprovalRequestId");
export type ApprovalRequestId = typeof ApprovalRequestId.Type;
export const CheckpointRef = makeEntityId("CheckpointRef");
export type CheckpointRef = typeof CheckpointRef.Type;
export const CheckpointId = makeEntityId("CheckpointId");
export type CheckpointId = typeof CheckpointId.Type;
export const CheckpointScopeId = makeEntityId("CheckpointScopeId");
export type CheckpointScopeId = typeof CheckpointScopeId.Type;
export const ContextHandoffId = makeEntityId("ContextHandoffId");
export type ContextHandoffId = typeof ContextHandoffId.Type;
export const ContextTransferId = makeEntityId("ContextTransferId");
export type ContextTransferId = typeof ContextTransferId.Type;
export const RawEventId = makeEntityId("RawEventId");
export type RawEventId = typeof RawEventId.Type;
export const PlanId = makeEntityId("PlanId");
export type PlanId = typeof PlanId.Type;
