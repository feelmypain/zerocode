import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@zerocode/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";

import { unknownRecord } from "./clientPolicy.ts";

type Field =
  | { readonly kind: "text"; readonly minLength: number }
  | { readonly kind: "number"; readonly integer: boolean }
  | { readonly kind: "boolean" }
  | { readonly kind: "choice"; readonly values: ReadonlySet<string> }
  | {
      readonly kind: "multiChoice";
      readonly values: ReadonlySet<string>;
      readonly minItems: number;
      readonly maxItems: number;
    };

type Option = OrchestrationV2UserInputQuestion["options"][number];

interface FoldedCompanion {
  readonly id: string;
  readonly options: ReadonlyArray<Option>;
  readonly sentinelValue?: string;
}

const COMPANION_SUFFIX_PATTERN =
  /^(?:__|_|-)((?:other|custom|freeform|free_form|free-form|freetext|free_text|free-text)(?:(?:_|-)(?:text|answer|response|input))?)$/i;
const COMPANION_CAMEL_SUFFIX_PATTERN =
  /^(?:Other|Custom|Freeform|FreeForm|Freetext|FreeText)(?:Text|Answer|Response|Input)?$/;
const STANDALONE_COMPANION_ID_PATTERN =
  /^(?:other|custom|freeform|free_form|free-form|freetext|free_text|free-text)(?:(?:_|-)(?:text|answer|response|input))?$/i;
const COMPANION_COPY_PATTERN =
  /(?:\boptional\s+free[\s-]?form\b|\bfree[\s-]?form\s+(?:answer|response|reply|input|text|option|override)\b|^(?:optional\s+)?(?:free[\s-]?form|other|custom\s+(?:answer|response|input|text))(?:\s*\([^)]*\))?[:.]?$|^other\s*\([^)]*\)\.?$|^(?:type|add|enter|write|provide|specify)\s+(?:your\s+)?(?:own|custom|other)\b)/i;
const TRAILING_INDEX_PATTERN = /^(.*?)(?:__|_|-)(\d+)$/;
const TRAILING_DIGITS_PATTERN = /(?:^|[^\d])(\d+)$/;
const CHOICE_STEM_SUFFIX_PATTERN =
  /(?:__|_|-)(?:choice|option|options|selection|select|answer|value)$/i;
const SENTINEL_OTHER_VALUE_PATTERN = /^(?:__)?other(?:__)?$/i;
const ATTACHMENT_SUFFIX_PATTERN = /^\n\nAttached (?:image|file) "(?:\\.|[^"\\\r\n])*": "/;

export interface ElicitationForm {
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  /**
   * Types answers as the schema declares them. Unknown keys and options are
   * dropped, as is an answer that does not fit its field. Returns undefined
   * when a required field is left without a valid answer.
   */
  readonly content: (
    answers: ProviderUserInputAnswers,
  ) => Record<string, EffectAcpSchema.ElicitationContentValue> | undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** All of `entries` as options, or undefined when any entry cannot be one. */
function choiceOptions(
  entries: unknown,
  toOption: (entry: unknown) => Option | undefined,
): Option[] | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const options = entries.map(toOption);
  return options.every((option) => option !== undefined) ? options : undefined;
}

function enumOptions(entries: unknown): Option[] | undefined {
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    !entries.every((value): value is string => typeof value === "string")
  )
    return undefined;
  const counts = new Map<string, number>();
  for (const value of entries) counts.set(value.trim(), (counts.get(value.trim()) ?? 0) + 1);
  const options = entries.map((value) => {
    const plain = value.trim();
    const label = plain !== "" && counts.get(plain) === 1 ? plain : JSON.stringify(value);
    return { label, description: label, value };
  });
  // A quoted fallback can collide with a literal label; quote every value in that case.
  return new Set(options.map((option) => option.label)).size === options.length
    ? options
    : options.map((option) => {
        const label = JSON.stringify(option.value);
        return { ...option, label, description: label };
      });
}

/** Titled entries (`oneOf` on strings, `anyOf` on array items) carry a title for their `const`. */
function titledOption(entry: unknown): Option | undefined {
  const option = unknownRecord(entry);
  const label = text(option?.title) ?? text(option?.const);
  return typeof option?.const === "string" && label !== undefined
    ? { label, description: text(option.description) ?? label, value: option.const }
    : undefined;
}

function parseField(
  property: Readonly<Record<string, unknown>>,
): { readonly field: Field; readonly options: Option[] } | undefined {
  switch (property.type) {
    case "string": {
      // ACP treats a null `enum` or `oneOf` like an omitted one.
      if ((property.enum ?? property.oneOf ?? undefined) === undefined) {
        const minLength =
          typeof property.minLength === "number" && property.minLength > 0 ? property.minLength : 0;
        return { field: { kind: "text", minLength }, options: [] };
      }
      const options = Array.isArray(property.oneOf)
        ? choiceOptions(property.oneOf, titledOption)
        : enumOptions(property.enum);
      return options === undefined
        ? undefined
        : {
            field: { kind: "choice", values: new Set(options.map(optionValue)) },
            options,
          };
    }
    case "array": {
      // String items list plain values in `enum`; titled items list `{ const, title }` in `anyOf`.
      const items = unknownRecord(property.items);
      const options =
        items?.type === "string"
          ? enumOptions(items.enum)
          : items !== undefined && items.type === undefined
            ? choiceOptions(items.anyOf, titledOption)
            : undefined;
      if (options === undefined) return undefined;
      // The schema decode already limits counts to non-negative integers.
      const values = new Set(options.map(optionValue));
      const minItems = typeof property.minItems === "number" ? property.minItems : 0;
      const maxItems = typeof property.maxItems === "number" ? property.maxItems : Infinity;
      // Empty-only questions carry no choice worth asking.
      if (maxItems === 0 || minItems > maxItems || minItems > values.size) return undefined;
      return { field: { kind: "multiChoice", values, minItems, maxItems }, options };
    }
    case "boolean":
      return {
        field: { kind: "boolean" },
        options: [
          { label: "true", description: "Yes", value: "true" },
          { label: "false", description: "No", value: "false" },
        ],
      };
    case "number":
    case "integer":
      return { field: { kind: "number", integer: property.type === "integer" }, options: [] };
    default:
      return undefined;
  }
}

function optionValue(option: Option): string {
  return option.value ?? option.label;
}

function typedAnswer(
  field: Field,
  answer: unknown,
): EffectAcpSchema.ElicitationContentValue | undefined {
  switch (field.kind) {
    case "text":
      return typeof answer === "string" && answer.length >= field.minLength ? answer : undefined;
    case "boolean":
      if (typeof answer === "boolean") return answer;
      return answer === "true" ? true : answer === "false" ? false : undefined;
    case "number": {
      const parsed =
        typeof answer === "number"
          ? answer
          : typeof answer === "string" && answer.trim().length > 0
            ? Number(answer.trim())
            : Number.NaN;
      if (!Number.isFinite(parsed)) return undefined;
      return field.integer && !Number.isInteger(parsed) ? undefined : parsed;
    }
    case "choice":
      return typeof answer === "string" && field.values.has(answer) ? answer : undefined;
    case "multiChoice": {
      if (!Array.isArray(answer)) return undefined;
      const selected = [
        ...new Set(
          answer.filter(
            (entry): entry is string => typeof entry === "string" && field.values.has(entry),
          ),
        ),
      ];
      // `[]` is an explicit empty selection, but a selection of only unknown
      // options is not one.
      if (selected.length === 0 && answer.length > 0) return undefined;
      return selected.length >= field.minItems && selected.length <= field.maxItems
        ? selected
        : undefined;
    }
  }
}

function hasCompanionCopy(property: Readonly<Record<string, unknown>>): boolean {
  const title = text(property.title);
  const description = text(property.description);
  return (
    (title !== undefined && COMPANION_COPY_PATTERN.test(title)) ||
    (description !== undefined && COMPANION_COPY_PATTERN.test(description))
  );
}

function trailingDigits(id: string): string | undefined {
  return TRAILING_DIGITS_PATTERN.exec(id)?.[1];
}

function isCompanionIdForChoice(choiceId: string, candidateId: string): boolean {
  if (candidateId.startsWith(choiceId)) {
    const suffix = candidateId.slice(choiceId.length);
    if (COMPANION_SUFFIX_PATTERN.test(suffix) || COMPANION_CAMEL_SUFFIX_PATTERN.test(suffix)) {
      return true;
    }
  }
  if (CHOICE_STEM_SUFFIX_PATTERN.test(choiceId)) {
    const stem = choiceId.replace(CHOICE_STEM_SUFFIX_PATTERN, "");
    if (stem.length > 0 && candidateId.startsWith(stem)) {
      const suffix = candidateId.slice(stem.length);
      if (COMPANION_SUFFIX_PATTERN.test(suffix) || COMPANION_CAMEL_SUFFIX_PATTERN.test(suffix)) {
        return true;
      }
    }
  }
  const candidateIndexed = TRAILING_INDEX_PATTERN.exec(candidateId);
  if (candidateIndexed !== null && STANDALONE_COMPANION_ID_PATTERN.test(candidateIndexed[1]!)) {
    const choiceDigits = trailingDigits(choiceId);
    if (choiceDigits !== undefined && choiceDigits === candidateIndexed[2]) {
      return true;
    }
  }
  return false;
}

function findSentinelOtherValue(field: Field, options: ReadonlyArray<Option>): string | undefined {
  if (options.length < 2) return undefined;
  const matches = options.filter((option) =>
    SENTINEL_OTHER_VALUE_PATTERN.test(optionValue(option)),
  );
  if (matches.length !== 1) return undefined;
  if (field.kind === "multiChoice" && field.minItems > options.length - 1) return undefined;
  return optionValue(matches[0]!);
}

function splitAttachmentSuffix(value: string): { prefix: string; suffix: string } | undefined {
  const marker = value.indexOf("\n\n");
  if (marker < 0) return undefined;
  const suffix = value.slice(marker);
  if (!ATTACHMENT_SUFFIX_PATTERN.test(suffix)) return undefined;
  return { prefix: value.slice(0, marker), suffix };
}

// Decline unaskable forms; validate types and selection counts, leaving other constraints to the agent.
// `allowOther` lets single choices take typed text, sent as the field's value.
export function parseElicitationForm(
  requestedSchema: unknown,
  message: string,
  { allowOther = false }: { readonly allowOther?: boolean } = {},
): ElicitationForm | undefined {
  const schema = unknownRecord(requestedSchema);
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [],
  );
  const fields = new Map<string, Field>();
  const parsedFields: Array<{
    readonly id: string;
    readonly property: Readonly<Record<string, unknown>>;
    options: Option[];
  }> = [];
  for (const [id, value] of Object.entries(unknownRecord(schema?.properties) ?? {})) {
    const property = unknownRecord(value);
    const parsed = property === undefined ? undefined : parseField(property);
    // Question ids must survive the contract's trim to round-trip answers.
    if (property === undefined || parsed === undefined || text(id) !== id) return undefined;
    fields.set(id, parsed.field);
    parsedFields.push({ id, property, options: parsed.options });
  }
  // Fold optional free-form text companions into their choice/multi-select question so
  // answering a choice advances straight to the next question instead of an extra text step.
  const companions = new Map<string, FoldedCompanion>();
  const folded = new Set<string>();
  const isChoiceKind = (field: Field | undefined): boolean =>
    field?.kind === "choice" || field?.kind === "multiChoice";
  const isOptionalText = (id: string): boolean =>
    fields.get(id)?.kind === "text" && !required.has(id);
  const choiceCount = parsedFields.filter((entry) => isChoiceKind(fields.get(entry.id))).length;

  const pairCompanion = (entry: (typeof parsedFields)[number], companionId: string) => {
    const field = fields.get(entry.id);
    if (field === undefined || (field.kind !== "choice" && field.kind !== "multiChoice")) return;
    const sentinelValue = findSentinelOtherValue(field, entry.options);
    if (sentinelValue !== undefined) {
      entry.options = entry.options.filter((option) => optionValue(option) !== sentinelValue);
      fields.set(entry.id, { ...field, values: new Set(entry.options.map(optionValue)) });
    }
    companions.set(entry.id, {
      id: companionId,
      options: entry.options,
      ...(sentinelValue === undefined ? {} : { sentinelValue }),
    });
    folded.add(companionId);
  };

  for (const entry of parsedFields) {
    if (!isChoiceKind(fields.get(entry.id))) continue;
    const match = parsedFields.find(
      (candidate) =>
        candidate.id !== entry.id &&
        !folded.has(candidate.id) &&
        isOptionalText(candidate.id) &&
        isCompanionIdForChoice(entry.id, candidate.id),
    );
    if (match !== undefined) pairCompanion(entry, match.id);
  }
  for (let index = 0; index < parsedFields.length - 1; index += 1) {
    const entry = parsedFields[index]!;
    if (!isChoiceKind(fields.get(entry.id)) || companions.has(entry.id)) continue;
    const next = parsedFields[index + 1]!;
    if (folded.has(next.id) || !isOptionalText(next.id)) continue;
    const entryDigits = trailingDigits(entry.id);
    const nextDigits = trailingDigits(next.id);
    if (entryDigits !== undefined && nextDigits !== undefined && entryDigits !== nextDigits) {
      continue;
    }
    if (
      hasCompanionCopy(next.property) ||
      (choiceCount === 1 && STANDALONE_COMPANION_ID_PATTERN.test(next.id))
    ) {
      pairCompanion(entry, next.id);
    }
  }

  const questions: OrchestrationV2UserInputQuestion[] = [];
  for (const { id, property, options } of parsedFields) {
    if (folded.has(id)) continue;
    const field = fields.get(id);
    const kind = field?.kind;
    questions.push({
      id,
      header: text(property.title) ?? `Question ${questions.length + 1}`,
      question: text(property.description) ?? message,
      options,
      ...(kind === "text" ||
      kind === "number" ||
      companions.has(id) ||
      (allowOther && kind === "choice")
        ? {}
        : { allowCustomAnswer: false }),
      ...(kind === "multiChoice" ? { multiSelect: true } : {}),
      // An empty selection answers "none" unless the schema demands a choice.
      ...(field?.kind === "multiChoice" && field.minItems > 0 && required.has(id)
        ? { required: true }
        : {}),
      ...(kind === "text" && !required.has(id) ? { required: false } : {}),
    });
  }
  return {
    questions,
    content: (answers) => {
      const entries: Array<[string, EffectAcpSchema.ElicitationContentValue]> = [];
      for (const [id, field] of fields) {
        if (folded.has(id)) continue;
        const answer = Object.hasOwn(answers, id) ? answers[id] : undefined;
        const typed = answer === undefined ? undefined : typedAnswer(field, answer);
        const companion = companions.get(id);
        if (typed !== undefined) {
          entries.push([id, typed]);
          if (
            companion !== undefined &&
            field.kind === "multiChoice" &&
            Object.hasOwn(answers, companion.id)
          ) {
            const companionAnswer = answers[companion.id];
            if (typeof companionAnswer === "string" && companionAnswer.trim() !== "") {
              entries.push([companion.id, companionAnswer]);
            }
          }
        } else if (
          allowOther &&
          field.kind === "choice" &&
          typeof answer === "string" &&
          answer.trim() !== ""
        ) {
          entries.push([id, answer]);
        } else if (companion !== undefined && typeof answer === "string" && answer.trim() !== "") {
          const split = splitAttachmentSuffix(answer);
          const attachedOption =
            split === undefined || field.kind !== "choice"
              ? undefined
              : companion.options.find((option) => optionValue(option) === split.prefix);
          if (attachedOption !== undefined && split !== undefined) {
            entries.push(
              [id, split.prefix],
              [companion.id, `${attachedOption.label}${split.suffix}`],
            );
          } else {
            if (companion.sentinelValue !== undefined) {
              entries.push([
                id,
                field.kind === "multiChoice" ? [companion.sentinelValue] : companion.sentinelValue,
              ]);
            }
            entries.push([companion.id, answer]);
          }
        } else if (required.has(id)) return undefined;
      }
      // Own properties for every field, `__proto__` included; assigning to
      // `{}` would hit its inherited setter instead.
      return Object.fromEntries(entries);
    },
  };
}
