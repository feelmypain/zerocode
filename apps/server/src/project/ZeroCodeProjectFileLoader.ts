import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ZEROCODE_PROJECT_FILE_NAME, type ZeroCodeProjectFile } from "@zerocode/contracts";
import { ZeroCodeProjectFileFromJson } from "@zerocode/shared/zeroCodeProjectFile";

const decodeZeroCodeProjectFileJson = Schema.decodeEffect(ZeroCodeProjectFileFromJson);

export class ZeroCodeProjectFileLoadError extends Schema.TaggedError<ZeroCodeProjectFileLoadError>()(
  "ZeroCodeProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${ZEROCODE_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

export class ZeroCodeProjectFileLoader extends Context.Service<
  ZeroCodeProjectFileLoader,
  {
    /** Never fails; missing/unreadable/invalid files return none, with warnings for invalid files. */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<ZeroCodeProjectFile>>;
  }
>()("zerocode/project/ZeroCodeProjectFileLoader") {}

const logZeroCodeProjectFileLoadError = (error: ZeroCodeProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: ZeroCodeProjectFileLoader["Service"]["load"] = Effect.fn(
    "ZeroCodeProjectFileLoader.load",
  )(function* (workspaceRoot) {
    const filePath = path.join(workspaceRoot, ZEROCODE_PROJECT_FILE_NAME);
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : logZeroCodeProjectFileLoadError(
                new ZeroCodeProjectFileLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  cause: error,
                }),
              ).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<ZeroCodeProjectFile>();
    }
    return yield* decodeZeroCodeProjectFileJson(raw.value).pipe(
      Effect.asSome,
      Effect.catchTags({
        SchemaError: (error) =>
          logZeroCodeProjectFileLoadError(
            new ZeroCodeProjectFileLoadError({
              operation: "decode",
              workspaceRoot,
              filePath,
              cause: error,
            }),
          ).pipe(Effect.as(Option.none<ZeroCodeProjectFile>())),
      }),
    );
  });

  return ZeroCodeProjectFileLoader.of({ load });
});

export const layer = Layer.effect(ZeroCodeProjectFileLoader, make);
