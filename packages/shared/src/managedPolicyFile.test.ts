import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as HostProcess from "./HostProcess.ts";

import {
  type FfiRsModule,
  MACOS_MANAGED_PREFERENCES_PATH,
  managedPolicyPath,
  readManagedPolicy,
  type RegistryKey,
  WINDOWS_POLICY_KEY,
  layerWindowsRegistry,
  WindowsRegistry,
  WindowsRegistryError,
} from "./managedPolicyFile.ts";

const policy = JSON.stringify({ schemaVersion: 1, organization: "Example Corp" });

/** What a command prints and exits with. */
type Result = { readonly stdout: string; readonly exitCode: number };

/** Keys below the policy key ("" for the key itself), or the error every read fails with. */
type RegistryAnswer = Readonly<Record<string, RegistryKey>> | WindowsRegistryError;
const isRegistryError = Schema.is(WindowsRegistryError);
const POLICY_SUBKEY = WINDOWS_POLICY_KEY.slice("HKLM\\".length);

/** Files that exist, what a command prints and exits with by command name, and the registry. */
const machine = (
  files: Readonly<Record<string, string>>,
  commands: Readonly<Record<string, Result>>,
  registry: RegistryAnswer,
) =>
  Layer.mergeAll(
    Layer.succeed(
      WindowsRegistry,
      WindowsRegistry.of({
        readMachineKey: (subkey) =>
          isRegistryError(registry)
            ? Effect.fail(registry)
            : Effect.succeed(registry[subkey.slice(POLICY_SUBKEY.length + 1)]),
      }),
    ),
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(path in files),
      readFileString: (path) => Effect.succeed(files[path] ?? ""),
    }),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const { command: name } = command as unknown as { readonly command: string };
        const result = commands[name] ?? { stdout: "", exitCode: 127 };
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(new TextEncoder().encode(result.stdout)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }),
    ),
  );

/** A policy key holding `values`, with checkbox subkeys of `name=0|1` entries. */
const policyKey = (
  values: RegistryKey["values"],
  subkeys: Readonly<Record<string, Readonly<Record<string, number>>>> = {},
): Readonly<Record<string, RegistryKey>> => ({
  "": { values, subkeys: Object.keys(subkeys) },
  ...Object.fromEntries(
    Object.entries(subkeys).map(([name, boxes]) => [
      name,
      {
        values: Object.entries(boxes).map(([box, data]) => ({
          name: box,
          type: "REG_DWORD" as const,
          data,
        })),
        subkeys: [],
      },
    ]),
  ),
});
const text = (name: string, data: string) => ({ name, type: "REG_SZ" as const, data });
const dword = (name: string, data: number) => ({ name, type: "REG_DWORD" as const, data });

const read = (
  platform: NodeJS.Platform,
  files: Readonly<Record<string, string>>,
  commands: Parameters<typeof machine>[1] = {},
  registry: RegistryAnswer = {},
) =>
  readManagedPolicy(platform).pipe(
    Effect.map((found) => found?.source),
    Effect.catchTags({
      ManagedPolicyFileError: (error) => Effect.succeed(`error: ${error.reason}`),
    }),
    Effect.provide(machine(files, commands, registry)),
  );

describe("readManagedPolicy", () => {
  it.effect("reads a macOS configuration profile, and refuses one beside a policy file", () =>
    Effect.gen(function* () {
      const plutil = { "/usr/bin/plutil": { stdout: policy, exitCode: 0 } };
      const profile = { [MACOS_MANAGED_PREFERENCES_PATH]: "<binary plist>" };
      const file = { [managedPolicyPath("darwin")]: policy };

      assert.equal(yield* read("darwin", profile, plutil), MACOS_MANAGED_PREFERENCES_PATH);
      const plist = (contents: object) => ({
        "/usr/bin/plutil": { stdout: JSON.stringify(contents), exitCode: 0 },
      });
      const settings = JSON.parse(policy);
      // What macOS 27 writes for a manually installed profile.
      assert.equal(
        yield* read(
          "darwin",
          profile,
          plist({ ...settings, PayloadUUID: "e8c7f49b", _manualProfile: true }),
        ),
        MACOS_MANAGED_PREFERENCES_PATH,
      );
      assert.equal(
        yield* read("darwin", profile, plist({ Forced: [{ mcx_preference_settings: settings }] })),
        MACOS_MANAGED_PREFERENCES_PATH,
      );
      // Keys beside the wrapper, or a second entry, are refused rather than dropped or merged.
      for (const ambiguous of [
        { Forced: [{ mcx_preference_settings: settings }], limits: { connect: false } },
        { Forced: [{ mcx_preference_settings: settings }, { mcx_preference_settings: settings }] },
      ]) {
        assert.include(
          yield* read("darwin", profile, plist(ambiguous)),
          "does not match the policy schema",
        );
      }
      assert.equal(yield* read("darwin", file), managedPolicyPath("darwin"));
      const typo = JSON.stringify({ ...settings, limits: { maxRuntimeMod: "auto" } });
      assert.include(
        yield* read("darwin", { [managedPolicyPath("darwin")]: typo }),
        '["limits"]["maxRuntimeMod"]',
      );
      assert.isUndefined(yield* read("darwin", {}));
      assert.include(
        yield* read("darwin", { ...profile, ...file }, plutil),
        "deploy the policy one way",
      );
      // A profile plutil cannot convert fails closed rather than reading as no policy.
      assert.include(
        yield* read("darwin", profile, { "/usr/bin/plutil": { stdout: "", exitCode: 1 } }),
        "cannot be read",
      );
    }),
  );

  it.effect(
    "reads a Policy value of JSON from the registry, and treats only an absent key as none",
    () =>
      Effect.gen(function* () {
        const file = { [managedPolicyPath("win32")]: policy };
        const win32 = (files: Readonly<Record<string, string>>, registry: RegistryAnswer) =>
          read("win32", files, {}, registry);
        const json = policyKey([text("Policy", policy)]);

        assert.equal(yield* win32({}, json), WINDOWS_POLICY_KEY);
        assert.isUndefined(yield* win32({}, {}));
        assert.equal(yield* win32(file, {}), managedPolicyPath("win32"));
        assert.include(yield* win32(file, json), "deploy the policy one way");
        // A read that fails, here access denied, is not read as no policy, file or not.
        for (const files of [{}, file]) {
          assert.include(
            yield* win32(files, new WindowsRegistryError({ code: 5 })),
            "the registry cannot be read (Windows error 5)",
          );
        }
        assert.include(
          yield* win32({}, new WindowsRegistryError({})),
          "cannot load its registry reader; reinstall ZeroCode",
        );
        assert.include(
          yield* win32({}, policyKey([{ name: "Policy", type: "other" }])),
          "its Policy value is not a string (REG_SZ)",
        );
        assert.include(
          yield* win32({}, policyKey([text("Policy", "{ not json")])),
          "does not match the policy schema",
        );
        for (const both of [
          policyKey([text("Policy", policy), text("Organization", "Example")]),
          policyKey([text("Policy", policy)], { Clients: { desktop: 1 } }),
        ]) {
          assert.include(yield* win32({}, both), "both a Policy value and Group Policy settings");
        }
        // Not Configured clears a list policy's values but can leave its empty subkey behind.
        assert.equal(
          yield* win32({}, policyKey([text("Policy", policy)], { Clients: {} })),
          WINDOWS_POLICY_KEY,
        );
      }),
  );

  it.effect("builds the policy from the values the Group Policy template writes", () =>
    Effect.gen(function* () {
      const organization = text("Organization", "Société 日本 ✓");
      const document = (registry: RegistryAnswer) =>
        readManagedPolicy("win32", ["codex", "claudeAgent"]).pipe(
          Effect.map((found): unknown => found?.document),
          Effect.catchTags({
            ManagedPolicyFileError: (error) => Effect.succeed(`error: ${error.reason}`),
          }),
          Effect.provide(machine({}, {}, registry)),
        );

      assert.deepStrictEqual(
        yield* document(
          policyKey(
            [
              organization,
              text("SupportUrl", ""),
              // Registry names ignore case.
              text("maxRuntimeMode", "auto-accept-edits"),
              dword("WebhookTasks", 0),
              text("Settings", '{"enableAgentBrowserAccess": {"value": false, "locked": true}}'),
              text("UpdatesMode", "off"),
              dword("AllowNightly", 1),
              dword("Updates", 1),
              dword("Clients", 1),
              dword("AllowedDrivers", 1),
            ],
            // Registry names ignore case, so a subkey written in other case still counts.
            {
              clients: { Desktop: 1, "LOCAL-BROWSER": 1, REMOTE: 1 },
              AllowedDrivers: { Codex: 1, CLAUDEAGENT: 1, UnknownDriver: 1 },
            },
          ),
        ),
        {
          schemaVersion: 1,
          organization: "Société 日本 ✓",
          settings: { enableAgentBrowserAccess: { value: false, locked: true } },
          limits: {
            maxRuntimeMode: "auto-accept-edits",
            webhookTasks: false,
            updates: { mode: "off", allowNightly: true },
            clients: ["desktop", "local-browser", "remote"],
            providers: { allowedDrivers: ["codex", "claudeAgent", "UnknownDriver"] },
          },
        },
      );

      // Disabling a policy leaves each checkbox's falseValue behind; it restricts nothing.
      const disabledGroups = {
        Clients: { desktop: 0, "local-browser": 0, remote: 0 },
        AllowedDrivers: { codex: 0, claudeAgent: 0 },
      };
      assert.deepStrictEqual(
        yield* document(
          policyKey(
            [
              organization,
              dword("Clients", 0),
              dword("AllowedDrivers", 0),
              dword("Updates", 0),
              dword("AllowNightly", 0),
              dword("WebhookTasks", 0),
            ],
            disabledGroups,
          ),
        ),
        { schemaVersion: 1, organization: "Société 日本 ✓", limits: { webhookTasks: false } },
      );
      // With nothing else configured, that is no policy rather than one missing Organization.
      assert.isUndefined(
        yield* document(
          policyKey([dword("AllowedDrivers", 0)], {
            AllowedDrivers: disabledGroups.AllowedDrivers,
          }),
        ),
      );
      assert.isUndefined(yield* document(policyKey([])));

      // Anything the template does not write fails closed rather than being ignored.
      for (const [registry, reason] of [
        [policyKey([organization, dword("WebhookTasks", 2)]), "DWORD of 0 or 1"],
        [policyKey([organization, text("MaxMode", "auto")]), "not a ZeroCode policy value"],
        [policyKey([organization], { Other: { x: 1 } }), "Other is not a ZeroCode policy key"],
        [
          {
            ...policyKey([organization, dword("Clients", 1)], { Clients: { desktop: 1 } }),
            Clients: { values: [dword("desktop", 1)], subkeys: ["Nested"] },
          },
          "Clients\\Nested is not a ZeroCode policy key",
        ],
        [policyKey([organization, text("Settings", "{")]), "not valid JSON"],
        [policyKey([organization, dword("Clients", 2)]), "DWORD of 0 or 1"],
        [
          policyKey([organization, dword("Clients", 1)], { Clients: { UnknownClient: 1 } }),
          "does not match the policy schema",
        ],
        [
          policyKey([organization, dword("Clients", 1)], { Clients: { desktop: 0 } }),
          "does not match the policy schema",
        ],
        [policyKey([dword("Organization", 1)]), "Organization must be a string"],
        // REG_EXPAND_SZ would fill in the reading user's variables.
        [policyKey([{ name: "Organization", type: "other" }]), "Organization must be a string"],
        [
          policyKey([text("MaxRuntimeMode", "auto-accept-edits")]),
          "set the Organization policy whenever another ZeroCode policy is set",
        ],
      ] as const) {
        assert.include(yield* document(registry), reason);
      }
    }),
  );

  it.effect("reads registry values and subkeys through a typed FfiRsModule implementation", () => {
    const DataType = {
      BigInt: 16,
      I32: 1,
      U32: 20,
      U8Array: 10,
      WString: 15,
    } as const;
    const REG_SZ = 1;
    const REG_EXPAND_SZ = 2;
    const REG_DWORD = 4;
    const ERROR_FILE_NOT_FOUND = 2;
    const ERROR_MORE_DATA = 234;
    const ERROR_NO_MORE_ITEMS = 259;

    const keys = new Map<
      string,
      {
        readonly values: ReadonlyArray<{
          readonly name: string;
          readonly type: number;
          readonly data: Buffer;
        }>;
        readonly subkeys: ReadonlyArray<string>;
      }
    >([
      [
        "SOFTWARE\\Policies\\ZeroCode\\ZeroCode",
        {
          values: [
            {
              name: "Organization",
              type: REG_SZ,
              data: Buffer.from("Example Corp\0", "utf16le"),
            },
            {
              name: "LargePolicy",
              type: REG_SZ,
              data: Buffer.from(`${"x".repeat(40_000)}\0`, "utf16le"),
            },
            {
              name: "WebhookTasks",
              type: REG_DWORD,
              data: (() => {
                const buf = Buffer.alloc(4);
                buf.writeUInt32LE(1);
                return buf;
              })(),
            },
            {
              name: "Expanded",
              type: REG_EXPAND_SZ,
              data: Buffer.from("%ProgramFiles%\\ZeroCode\0", "utf16le"),
            },
          ],
          subkeys: ["Clients", "AllowedDrivers"],
        },
      ],
    ]);

    const openedLibraries: Array<{ library: string; path: string }> = [];
    const openHandles = new Map<bigint, string>();
    const closedHandles: Array<bigint> = [];
    let nextHandle = 100n;

    const mockFfi: FfiRsModule<(typeof DataType)[keyof typeof DataType]> = {
      DataType,
      open: (params) => {
        openedLibraries.push(params);
      },
      load: ({ funcName, paramsValue }) => {
        if (funcName === "RegOpenKeyExW") {
          const subkey = paramsValue[1] as string;
          const handleBuf = paramsValue[4] as Buffer;
          if (!keys.has(subkey)) return ERROR_FILE_NOT_FOUND;
          const handle = nextHandle++;
          openHandles.set(handle, subkey);
          handleBuf.writeBigInt64LE(handle);
          return 0;
        }
        if (funcName === "RegEnumValueW") {
          const handle = paramsValue[0] as bigint;
          const index = paramsValue[1] as number;
          const nameBuf = paramsValue[2] as Buffer;
          const nameCharsBuf = paramsValue[3] as Buffer;
          const typeBuf = paramsValue[5] as Buffer;
          const dataBuf = paramsValue[6] as Buffer;
          const dataBytesBuf = paramsValue[7] as Buffer;
          const key = keys.get(openHandles.get(handle) ?? "");
          const entry = key?.values[index];
          if (!entry) return ERROR_NO_MORE_ITEMS;
          const encodedName = Buffer.from(`${entry.name}\0`, "utf16le");
          encodedName.copy(nameBuf);
          nameCharsBuf.writeUInt32LE(entry.name.length);
          typeBuf.writeUInt32LE(entry.type);
          const capacity = dataBytesBuf.readUInt32LE();
          dataBytesBuf.writeUInt32LE(entry.data.length);
          if (capacity < entry.data.length) return ERROR_MORE_DATA;
          entry.data.copy(dataBuf);
          return 0;
        }
        if (funcName === "RegEnumKeyExW") {
          const handle = paramsValue[0] as bigint;
          const index = paramsValue[1] as number;
          const nameBuf = paramsValue[2] as Buffer;
          const nameCharsBuf = paramsValue[3] as Buffer;
          const key = keys.get(openHandles.get(handle) ?? "");
          const subkey = key?.subkeys[index];
          if (!subkey) return ERROR_NO_MORE_ITEMS;
          const encodedName = Buffer.from(`${subkey}\0`, "utf16le");
          encodedName.copy(nameBuf);
          nameCharsBuf.writeUInt32LE(subkey.length);
          return 0;
        }
        if (funcName === "RegCloseKey") {
          const handle = paramsValue[0] as bigint;
          closedHandles.push(handle);
          openHandles.delete(handle);
          return 0;
        }
        throw new Error(`Unexpected Win32 call: ${funcName}`);
      },
    };

    return Effect.gen(function* () {
      const registry = yield* WindowsRegistry;
      const found = yield* registry.readMachineKey("SOFTWARE\\Policies\\ZeroCode\\ZeroCode");
      assert.deepStrictEqual(openedLibraries, [
        { library: "zerocode-advapi32", path: "advapi32.dll" },
      ]);
      assert.deepStrictEqual(found, {
        values: [
          { name: "Organization", type: "REG_SZ", data: "Example Corp" },
          { name: "LargePolicy", type: "REG_SZ", data: "x".repeat(40_000) },
          { name: "WebhookTasks", type: "REG_DWORD", data: 1 },
          { name: "Expanded", type: "other" },
        ],
        subkeys: ["Clients", "AllowedDrivers"],
      });
      assert.isUndefined(yield* registry.readMachineKey("SOFTWARE\\ZeroCodeNoSuchKey"));
      assert.deepStrictEqual(closedHandles, [100n]);
    }).pipe(
      Effect.provide(
        layerWindowsRegistry(() => Promise.resolve(mockFfi)).pipe(
          Layer.provide(Layer.succeed(HostProcess.Architecture, "x64")),
        ),
      ),
    );
  });
});
