import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ForwardCompatibleArray,
  ForwardCompatibleNullable,
  ForwardCompatibleOptional,
  ForwardCompatibleUnion,
  ForwardCompatibleUnionArray,
  GitRefName,
  isUnknownUnionMember,
  OmittedWhenNull,
  TrimmedNonEmptyString,
  TrimmedString,
  UnknownUnionMember,
} from "./baseSchemas.ts";

const at = "2026-10-05T00:00:00.000Z";
const Shape = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("circle"), radius: Schema.Number, at: Schema.DateTimeUtc }),
  Schema.Struct({ kind: Schema.Literal("square"), side: Schema.Number }),
]);
const members = Shape.members;
const fromWire = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema) as never) as (value: unknown) => S["Type"];

describe("ForwardCompatibleArray", () => {
  it("decodes elements through their own codec and drops ones it cannot read", () => {
    const shapes = ForwardCompatibleArray(Shape);
    const exit = Schema.toCodecJson(Schema.Exit(shapes, Schema.Never, Schema.Never));
    const wire = [
      { kind: "circle", radius: 1, at },
      { kind: "triangle" },
      { kind: "square", side: "wide" },
    ];
    const decoded = fromWire(shapes)(wire);
    expect(decoded).toHaveLength(1);
    expect(DateTime.isDateTime((decoded[0] as { at: unknown }).at)).toBe(true);
    expect(Schema.decodeSync(exit)({ _tag: "Success", value: wire })).toEqual(
      Exit.succeed(decoded),
    );
    expect(Schema.encodeSync(exit)(Exit.succeed(decoded))).toEqual({
      _tag: "Success",
      value: [wire[0]],
    });
  });

  const Named = ForwardCompatibleArray(Schema.Struct({ name: TrimmedNonEmptyString }));

  it("drops an element it cannot encode instead of failing the array", () => {
    const encodeNamed = Schema.encodeUnknownSync(Schema.toCodecJson(Named));

    const wire = JSON.parse(
      JSON.stringify(encodeNamed([{ name: "a" }, { name: " " }, { name: "b" }])),
    );
    expect(wire).toEqual([{ name: "a" }, { name: "b" }]);
    expect(fromWire(Named)(wire)).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("still drops the null holes a server on an earlier build sends", () => {
    expect(fromWire(Named)([{ name: "a" }, null, { name: "b" }])).toEqual([
      { name: "a" },
      { name: "b" },
    ]);
  });
});

const decodeTrimmed = Schema.decodeUnknownSync(TrimmedString);
const decodeNonEmpty = Schema.decodeUnknownSync(TrimmedNonEmptyString);
const encodeNonEmpty = Schema.encodeSync(TrimmedNonEmptyString);
const isNonEmpty = Schema.is(TrimmedNonEmptyString);
const decodeRef = Schema.decodeUnknownSync(GitRefName);
const isRef = Schema.is(GitRefName);

let countedOptionalDecodes = 0;
const CountedMode = Schema.Literals(["a", "b"]).pipe(
  Schema.decodeTo(
    Schema.Literals(["a", "b"]),
    SchemaTransformation.transform({
      decode: (value) => {
        countedOptionalDecodes += 1;
        return value;
      },
      encode: (value) => value,
    }),
  ),
);
const CountedOptionalStruct = Schema.Struct({ mode: ForwardCompatibleOptional(CountedMode) });
const CountedNullable = ForwardCompatibleNullable(CountedMode);
const CountedOmittedStruct = Schema.Struct({ mode: OmittedWhenNull(CountedMode) });
const decodeCountedOptional = Schema.decodeSync(CountedOptionalStruct);
const decodeCountedNullable = Schema.decodeSync(CountedNullable);
const encodeCountedNullable = Schema.encodeSync(CountedNullable);
const decodeCountedOmitted = Schema.decodeSync(CountedOmittedStruct);
const encodeCountedOmitted = Schema.encodeSync(CountedOmittedStruct);

let countedUnionChecks = 0;
const CountedCircle = Schema.Struct({
  kind: Schema.Literal("circle"),
  radius: Schema.Number.check(
    Schema.makeFilter((radius: number) => {
      countedUnionChecks += 1;
      return radius > 0;
    }),
  ),
});
const CountedUnionArray = ForwardCompatibleUnionArray([CountedCircle, members[1]], "kind");
const decodeCountedUnionArray = fromWire(CountedUnionArray);
const encodeCountedUnionArray = Schema.encodeSync(Schema.toCodecJson(CountedUnionArray));

describe("TrimmedString, TrimmedNonEmptyString, and GitRefName", () => {
  it("preserves exact trim and non-blank semantics across ASCII and Unicode whitespace", () => {
    expect(decodeTrimmed("")).toBe("");
    expect(decodeTrimmed("plain-id")).toBe("plain-id");
    expect(decodeTrimmed("  hello  ")).toBe("hello");
    expect(decodeTrimmed("\u00a0hello\u3000")).toBe("hello");
    expect(decodeTrimmed("\x00")).toBe("\x00");

    expect(decodeNonEmpty("  id-1  ")).toBe("id-1");
    expect(() => decodeNonEmpty("")).toThrow();
    expect(() => decodeNonEmpty("   ")).toThrow();
    expect(() => decodeNonEmpty("\u00a0\u3000")).toThrow();
    expect(isNonEmpty("   ")).toBe(false);
    expect(isNonEmpty("\u00a0")).toBe(false);
    expect(isNonEmpty("id-1")).toBe(true);
    expect(() => TrimmedNonEmptyString.make("   ")).toThrow();
    expect(() => encodeNonEmpty("   ")).toThrow();

    expect(decodeRef("  main\t")).toBe("main");
    expect(decodeRef("\u00a0main\u3000")).toBe("\u00a0main\u3000");
    expect(isRef("\u00a0")).toBe(true);
    expect(isRef(" \t\n ")).toBe(false);
    expect(() => decodeRef(" \t\n ")).toThrow();
    expect(() => GitRefName.make(" \t ")).toThrow();
  });
});

describe("ForwardCompatibleOptional", () => {
  const Settings = Schema.Struct({ mode: ForwardCompatibleOptional(Schema.Literals(["a", "b"])) });
  const encodeSettings = Schema.encodeUnknownSync(Schema.toCodecJson(Settings));

  it("encodes back to JSON after dropping a value it cannot read", () => {
    const decoded = fromWire(Settings)({ mode: "future" });
    expect("mode" in decoded).toBe(false);
    expect(encodeSettings(decoded)).toEqual({});
    expect(encodeSettings({ mode: undefined })).toEqual({});
    expect(encodeSettings(fromWire(Settings)({ mode: "a" }))).toEqual({ mode: "a" });
  });

  it("decodes valid values once across optional, nullable, and omitted-when-null wrappers", () => {
    countedOptionalDecodes = 0;

    expect(decodeCountedOptional({ mode: "a" })).toEqual({ mode: "a" });
    expect(countedOptionalDecodes).toBe(1);

    expect(decodeCountedNullable("b")).toBe("b");
    expect(countedOptionalDecodes).toBe(2);
    expect(decodeCountedNullable("future")).toBeNull();
    expect(encodeCountedNullable(null)).toBeNull();
    expect(encodeCountedNullable("a")).toBe("a");

    expect(decodeCountedOmitted({ mode: "a" })).toEqual({ mode: "a" });
    expect(countedOptionalDecodes).toBe(3);
    expect(decodeCountedOmitted({})).toEqual({ mode: null });
    expect(decodeCountedOmitted({ mode: "future" })).toEqual({ mode: null });
    expect("mode" in encodeCountedOmitted({ mode: null })).toBe(false);
    expect(encodeCountedOmitted({ mode: "a" })).toEqual({ mode: "a" });
  });
});

describe("ForwardCompatibleUnion", () => {
  const decode = fromWire(ForwardCompatibleUnion(members, "kind"));

  it("decodes a member from a newer server as unknown", () => {
    const decoded = decode({ kind: "triangle", corners: 3 });
    expect(isUnknownUnionMember(decoded)).toBe(true);
    expect(decoded).toEqual(new UnknownUnionMember("kind", "triangle"));
  });

  it("decodes known members in full, transformations included", () => {
    const decoded = decode({ kind: "circle", radius: 1, at });
    expect(isUnknownUnionMember(decoded)).toBe(false);
    expect(DateTime.isDateTime((decoded as { at: unknown }).at)).toBe(true);
  });

  it("still fails a known member whose payload is broken", () => {
    expect(() => decode({ kind: "square", side: "wide" })).toThrow();
  });
});

describe("ForwardCompatibleUnionArray", () => {
  it("keeps a known member however its fields are named", () => {
    const Flagged = Schema.Struct({
      kind: Schema.Literal("flag"),
      _unknown: Schema.Literal(true),
      tag: Schema.String,
      value: Schema.String,
    });
    const flag = { kind: "flag", _unknown: true, tag: "kind", value: "x" };
    expect(fromWire(ForwardCompatibleUnionArray([Flagged], "kind"))([flag])).toEqual([flag]);
  });

  const decode = fromWire(ForwardCompatibleUnionArray(members, "kind"));

  it("drops members a newer server added and keeps the rest", () => {
    const decoded = decode([
      { kind: "triangle" },
      { kind: "circle", radius: 1, at },
      { kind: "square", side: 2 },
    ]);
    expect(decoded.map((shape) => shape.kind)).toEqual(["circle", "square"]);
  });

  it("validates each known element once without re-running the union on decode", () => {
    countedUnionChecks = 0;
    const decoded = decodeCountedUnionArray([
      { kind: "circle", radius: 3 },
      { kind: "square", side: 2 },
    ]);
    expect(decoded).toEqual([
      { kind: "circle", radius: 3 },
      { kind: "square", side: 2 },
    ]);
    expect(countedUnionChecks).toBe(1);
    expect(encodeCountedUnionArray(decoded)).toEqual([
      { kind: "circle", radius: 3 },
      { kind: "square", side: 2 },
    ]);
  });

  it("fails when a known member is broken, so real bugs stay visible", () => {
    expect(() => decode([{ kind: "square", side: "wide" }])).toThrow();
  });
});
