import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ZeroCodeProjectFile, ZEROCODE_PROJECT_FILE_SCHEMA_URL } from "@zerocode/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const ZeroCodeProjectFileFromJson = fromLenientJson(ZeroCodeProjectFile);

const decodeZeroCodeProjectFile = Schema.decodeExit(ZeroCodeProjectFileFromJson);

export function parseZeroCodeProjectFile(contents: string): ZeroCodeProjectFile | null {
  const decoded = decodeZeroCodeProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildZeroCodeProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(ZeroCodeProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: ZEROCODE_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
