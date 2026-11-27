import { assert, describe, it } from "@effect/vitest";

import { parseElicitationForm } from "./elicitationForm.ts";

describe("parseElicitationForm", () => {
  for (const type of ["string", "array"] as const) {
    it.each([
      { values: [" padded ", "", "plain"], labels: ["padded", '""', "plain"] },
      { values: [" a", "a", "b"], labels: ['" a"', '"a"', "b"] },
      { values: [" a", "a", '"a"'], labels: ['" a"', '"a"', '"\\"a\\""'] },
    ])(
      `preserves ${type} enum values with distinct readable labels: $values`,
      ({ values, labels }) => {
        const form = parseElicitationForm(
          {
            type: "object",
            properties: {
              answer:
                type === "array"
                  ? { type, items: { type: "string", enum: values } }
                  : { type, enum: values },
            },
            required: ["answer"],
          },
          "Choose",
        );
        assert(form !== undefined);
        const question = form.questions[0];
        assert(question !== undefined);
        assert.deepStrictEqual(
          question.options.map((option) => option.label),
          labels,
        );
        assert.deepStrictEqual(
          question.options.map((option) => option.value),
          values,
        );
        assert.strictEqual(question.allowCustomAnswer, false);
        assert.strictEqual(question.multiSelect, type === "array" ? true : undefined);
        for (const value of values) {
          const answer = type === "array" ? [value] : value;
          assert.deepStrictEqual(form.content({ answer }), { answer });
        }
      },
    );
  }

  it("asks each question once when a choice has a free-text companion field", () => {
    // OMP's ask dialog follows each choice `q<n>` with a free-text `q<n>__other` field.
    const ask = (question: string, header: string) => ({
      type: "string",
      title: question,
      description: header,
      oneOf: [
        { const: "Yes", title: "Yes" },
        { const: "No", title: "No" },
      ],
    });
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          q0: ask("Use Postgres for the new service?", "Database"),
          q0__other: { type: "string", title: "Other (type your own)" },
          q1: ask("Deploy to staging first?", "Deploy"),
          q1__other: { type: "string", title: "Other (type your own)" },
        },
      },
      "Answer 2 questions",
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) =>
        [question.header, question.question].some((text) => text.endsWith("?")),
      ),
      [true, true],
    );
    assert.deepStrictEqual(form.content({ q0: "Yes", q1: "Only on Fridays" }), {
      q0: "Yes",
      q1__other: "Only on Fridays",
    });

    // Multi-select choices also fold their free-text companion so answering advances straight
    // to the next question instead of prompting with a separate optional text step.
    const multi = parseElicitationForm(
      {
        type: "object",
        properties: {
          q0: { type: "array", title: "Databases?", items: { anyOf: [{ const: "Postgres" }] } },
          q0__other: { type: "string", title: "Other (type your own)" },
        },
      },
      "Databases?",
    );
    assert(multi !== undefined);
    assert.deepStrictEqual(
      multi.questions.map((question) => [
        question.id,
        question.multiSelect,
        question.allowCustomAnswer,
      ]),
      [["q0", true, undefined]],
    );
    assert.deepStrictEqual(multi.content({ q0: ["Postgres"] }), { q0: ["Postgres"] });
    assert.deepStrictEqual(multi.content({ q0: "SQLite" }), { q0__other: "SQLite" });
    assert.deepStrictEqual(multi.content({ q0: ["Postgres"], q0__other: "SQLite" }), {
      q0: ["Postgres"],
      q0__other: "SQLite",
    });
  });

  it("folds Optional free-form companions across suffix, adjacent copy, and required choices", () => {
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          q0: {
            type: "string",
            title: "Database",
            description: "Which database?",
            enum: ["Postgres", "SQLite"],
          },
          q0_freeform: {
            type: "string",
            title: "Optional free-form",
            description: "Optional free-form answer",
          },
          q1: {
            type: "string",
            title: "Deploy",
            description: "Deploy to staging?",
            oneOf: [
              { const: "yes", title: "Yes" },
              { const: "no", title: "No" },
              { const: "other", title: "Other" },
            ],
          },
          q1_other: {
            type: "string",
            title: "Optional free-form",
          },
          q2: {
            type: "array",
            title: "Targets",
            description: "Which platforms?",
            items: { type: "string", enum: ["Web", "Mobile"] },
          },
          notes_2: {
            type: "string",
            description: "Optional free-form response",
          },
          extra_note: {
            type: "string",
            title: "Release notes",
            description: "Anything else to mention?",
            minLength: 1,
          },
        },
        required: ["q0", "q1"],
      },
      "Answer questions",
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) => ({
        id: question.id,
        options: question.options.map((option) => option.value),
        allowCustomAnswer: question.allowCustomAnswer,
        multiSelect: question.multiSelect,
      })),
      [
        {
          id: "q0",
          options: ["Postgres", "SQLite"],
          allowCustomAnswer: undefined,
          multiSelect: undefined,
        },
        {
          id: "q1",
          options: ["yes", "no"],
          allowCustomAnswer: undefined,
          multiSelect: undefined,
        },
        {
          id: "q2",
          options: ["Web", "Mobile"],
          allowCustomAnswer: undefined,
          multiSelect: true,
        },
        {
          id: "extra_note",
          options: [],
          allowCustomAnswer: undefined,
          multiSelect: undefined,
        },
      ],
    );
    assert.deepStrictEqual(
      form.content({
        q0: "Postgres",
        q1: "Only on Fridays",
        q2: ["Web"],
        extra_note: "",
      }),
      {
        q0: "Postgres",
        q1: "other",
        q1_other: "Only on Fridays",
        q2: ["Web"],
      },
    );
    assert.deepStrictEqual(
      form.content({
        q0: "DuckDB",
        q1: "yes",
        q2: "Desktop",
        extra_note: "Ship after QA",
      }),
      {
        q0_freeform: "DuckDB",
        q1: "yes",
        notes_2: "Desktop",
        extra_note: "Ship after QA",
      },
    );
    assert.strictEqual(form.content({ q0: "   ", q1: "yes" }), undefined);
  });

  it("folds standalone and indexed companion ids without folding unrelated text fields", () => {
    const single = parseElicitationForm(
      {
        type: "object",
        properties: {
          answer: { type: "string", title: "Strategy", enum: ["Fast", "Safe"] },
          other: { type: "string" },
        },
      },
      "Choose",
    );
    assert(single !== undefined);
    assert.deepStrictEqual(
      single.questions.map((question) => question.id),
      ["answer"],
    );
    assert.deepStrictEqual(single.content({ answer: "Fast" }), { answer: "Fast" });
    assert.deepStrictEqual(single.content({ answer: "Balanced" }), { other: "Balanced" });

    const indexed = parseElicitationForm(
      {
        type: "object",
        properties: {
          q0: { type: "string", title: "First", enum: ["A", "B"] },
          q1: { type: "string", title: "Second", enum: ["X", "Y"] },
          freeform_0: { type: "string" },
          freeform_1: { type: "string" },
          reason: { type: "string", title: "Reason", description: "Why?" },
        },
      },
      "Choose",
    );
    assert(indexed !== undefined);
    assert.deepStrictEqual(
      indexed.questions.map((question) => question.id),
      ["q0", "q1", "reason"],
    );
    assert.deepStrictEqual(indexed.content({ q0: "Custom 0", q1: "Y", reason: "Because" }), {
      freeform_0: "Custom 0",
      q1: "Y",
      reason: "Because",
    });
  });

  it("requires a multi-select only for a required minimum and accepts none otherwise", () => {
    const items = { type: "string", enum: ["web", "mobile"] };
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          targets: { type: "array", minItems: 1, items },
          extras: { type: "array", items },
          platforms: { type: "array", minItems: 1, items },
        },
        required: ["targets"],
      },
      "Choose",
    );
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) => [question.id, question.required]),
      [
        ["targets", true],
        ["extras", undefined],
        ["platforms", undefined],
      ],
    );
    assert.deepStrictEqual(form.content({ targets: ["web"], extras: [], platforms: [] }), {
      targets: ["web"],
      extras: [],
    });
  });
});
