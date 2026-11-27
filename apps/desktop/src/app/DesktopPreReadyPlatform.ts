// @effect-diagnostics nodeBuiltinImport:off - pre-ready Electron setup reads settings, prepares the Linux desktop entry, and asks Hyprland for its version synchronously before app services are available.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";
import * as HostProcess from "@zerocode/shared/HostProcess";

import {
  DEFAULT_LINUX_PASSWORD_STORE,
  type LinuxPasswordStorePreference,
} from "../linuxSecretStorage.ts";
import * as DesktopEarlyElectronStartup from "./DesktopEarlyElectronStartup.ts";
import {
  DesktopPreReadyElectronOptions,
  type EarlyDesktopSettingsSnapshot,
} from "./DesktopEarlyElectronStartup.ts";
import { trimmedString } from "./DesktopConfig.ts";
import { resolveDesktopAppBranding } from "./DesktopEnvironment.ts";
import {
  renderUrlHandlerDesktopEntry,
  replacedVersionedAppImagePath,
} from "./DesktopLinuxUrlHandler.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";

export { DesktopPreReadyElectronOptions, type EarlyDesktopSettingsSnapshot };

export interface DesktopPreReadyCommandLineReader {
  readonly hasSwitch: (switchName: string) => boolean;
  readonly getSwitchValue: (switchName: string) => string;
}

function readCommandLineSwitchValue(
  commandLine: DesktopPreReadyCommandLineReader,
  switchName: string,
): string | null {
  if (!commandLine.hasSwitch(switchName)) {
    return null;
  }

  const value = commandLine.getSwitchValue(switchName).trim();
  return value.length > 0 ? value : null;
}

function readEarlyDesktopSettingsSnapshot(homeDirectory: string): {
  readonly preference: LinuxPasswordStorePreference;
  readonly snapshot: EarlyDesktopSettingsSnapshot | undefined;
} {
  const settingsPath = DesktopEarlyElectronStartup.resolveEarlyDesktopSettingsPath({
    env: process.env,
    homeDirectory,
    joinPath: NodePath.posix.join,
  });
  try {
    const raw = NodeFS.readFileSync(settingsPath, "utf8");
    const preference = DesktopEarlyElectronStartup.parseEarlyLinuxPasswordStorePreference(raw);
    return {
      preference,
      snapshot: { path: settingsPath, raw, linuxPasswordStore: preference },
    };
  } catch (error) {
    return {
      preference: DEFAULT_LINUX_PASSWORD_STORE,
      snapshot:
        (error as NodeJS.ErrnoException)?.code === "ENOENT"
          ? { path: settingsPath, raw: null, linuxPasswordStore: DEFAULT_LINUX_PASSWORD_STORE }
          : undefined,
    };
  }
}

export const resolveEarlyLinuxElectronOptionsFromProcess = (
  homeDirectory: string,
  cachedSettings?: EarlyDesktopSettingsSnapshot,
): DesktopEarlyElectronStartup.EarlyLinuxElectronOptions => {
  if (cachedSettings !== undefined) {
    const settingsPath = DesktopEarlyElectronStartup.resolveEarlyDesktopSettingsPath({
      env: process.env,
      homeDirectory,
      joinPath: NodePath.posix.join,
    });
    if (cachedSettings.path === settingsPath) {
      return DesktopEarlyElectronStartup.resolveEarlyLinuxElectronOptionsFromPreference({
        env: process.env,
        preference: cachedSettings.linuxPasswordStore,
      });
    }
  }
  return DesktopEarlyElectronStartup.resolveEarlyLinuxElectronOptions({
    env: process.env,
    homeDirectory,
    joinPath: NodePath.posix.join,
    readFileString: (path) => NodeFS.readFileSync(path, "utf8"),
  });
};

const LinuxDesktopEntryConfig = Config.all({
  xdgDataHome: trimmedString("XDG_DATA_HOME"),
  launcherPath: trimmedString("ZEROCODE_DESKTOP_LAUNCHER_PATH"),
  appImagePath: trimmedString("APPIMAGE"),
  // electron-updater sets this on the AppImage it relaunches after installing an update.
  relaunchedByUpdater: trimmedString("APPIMAGE_SILENT_INSTALL"),
});

/** @public */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const linuxDesktopEntryConfig = yield* LinuxDesktopEntryConfig;
  return yield* Effect.sync((): DesktopPreReadyElectronOptions["Service"] => {
    const linuxPasswordStoreCommandLine =
      platform === "linux"
        ? readCommandLineSwitchValue(Electron.app.commandLine, "password-store")
        : null;
    let linux: DesktopEarlyElectronStartup.EarlyLinuxElectronOptions | null = null;
    let desktopSettingsSnapshot: EarlyDesktopSettingsSnapshot | undefined;
    if (platform === "linux") {
      const earlySettings = readEarlyDesktopSettingsSnapshot(homeDirectory);
      desktopSettingsSnapshot = earlySettings.snapshot;
      linux = DesktopEarlyElectronStartup.resolveEarlyLinuxElectronOptionsFromPreference({
        env: process.env,
        preference: earlySettings.preference,
      });
    }

    if (linux !== null) {
      DesktopEarlyElectronStartup.restoreEarlyLinuxDeviceScaleFactor({
        env: process.env,
        homeDirectory,
        joinPath: NodePath.posix.join,
        commandLine: Electron.app.commandLine,
        readFileString: (path) => NodeFS.readFileSync(path, "utf8"),
        writeFileString: (path, value) => {
          NodeFS.mkdirSync(NodePath.posix.dirname(path), { recursive: true });
          NodeFS.writeFileSync(path, value, "utf8");
        },
      });
      // The portal also requires a valid desktop entry. An AppImage update may
      // have removed the executable referenced by the previous launch's entry.
      try {
        const applicationsDir = NodePath.posix.join(
          Option.getOrElse(linuxDesktopEntryConfig.xdgDataHome, () =>
            NodePath.posix.join(homeDirectory, ".local", "share"),
          ),
          "applications",
        );
        const iconPath = Electron.app.isPackaged
          ? NodePath.posix.join(
              applicationsDir,
              "..",
              "icons",
              `${linux.linuxDesktopEntryName}.png`,
            )
          : undefined;
        if (iconPath !== undefined) {
          try {
            const iconBytes = NodeFS.readFileSync(
              NodePath.posix.join(
                Electron.app.getAppPath(),
                "apps/desktop/prod-resources/icon.png",
              ),
            );
            let iconMatches = false;
            try {
              const existingIcon = NodeFS.readFileSync(iconPath);
              iconMatches =
                Buffer.isBuffer(iconBytes) &&
                Buffer.isBuffer(existingIcon) &&
                existingIcon.equals(iconBytes);
            } catch {}
            if (!iconMatches) {
              NodeFS.mkdirSync(NodePath.posix.dirname(iconPath), { recursive: true });
              // Electron's copyFileSync from app.asar extracts to a temp file it never deletes.
              NodeFS.writeFileSync(iconPath, iconBytes);
            }
          } catch {}
        }
        const desktopEntryPath = NodePath.posix.join(applicationsDir, linux.linuxDesktopEntryName);
        let previousEntry: string | undefined;
        try {
          const raw = NodeFS.readFileSync(desktopEntryPath, "utf8");
          if (typeof raw === "string") previousEntry = raw;
        } catch {}
        const { appImagePath } = linuxDesktopEntryConfig;
        if (
          previousEntry !== undefined &&
          Option.isSome(appImagePath) &&
          Option.isNone(linuxDesktopEntryConfig.launcherPath) &&
          Option.contains(linuxDesktopEntryConfig.relaunchedByUpdater, "true")
        ) {
          try {
            const replacedPath = replacedVersionedAppImagePath({
              previousEntry,
              appImagePath: appImagePath.value,
            });
            // Relative, so the pair survives a moved folder; symlink never overwrites a file.
            if (replacedPath !== null) {
              NodeFS.symlinkSync(NodePath.posix.basename(appImagePath.value), replacedPath);
            }
          } catch {}
        }
        const desktopEntryContent = renderUrlHandlerDesktopEntry({
          displayName: resolveDesktopAppBranding({
            isDevelopment: linux.isDevelopment,
            appVersion: Electron.app.getVersion(),
          }).displayName,
          execTarget:
            Option.getOrUndefined(
              Option.orElse(
                linuxDesktopEntryConfig.launcherPath,
                () => linuxDesktopEntryConfig.appImagePath,
              ),
            ) ?? process.execPath,
          scheme: ElectronProtocol.getDesktopScheme(linux.isDevelopment),
          ...(iconPath === undefined ? {} : { iconPath }),
        });
        if (previousEntry !== desktopEntryContent) {
          NodeFS.mkdirSync(applicationsDir, { recursive: true });
          NodeFS.writeFileSync(desktopEntryPath, desktopEntryContent, "utf8");
        }
      } catch {}
      // Chromium caches portal identity; set it before any asynchronous initialization.
      Electron.app.setDesktopName(linux.linuxDesktopEntryName);
      if (linux.passwordStore !== null && linuxPasswordStoreCommandLine === null) {
        Electron.app.commandLine.appendSwitch("password-store", linux.passwordStore);
      }
      // Chromium keeps only the last --disable-features value, so pass the merged list.
      const disableFeatures = DesktopEarlyElectronStartup.resolveLinuxDisableFeaturesSwitch({
        env: process.env,
        ozonePlatform: readCommandLineSwitchValue(Electron.app.commandLine, "ozone-platform"),
        enableFeatures: readCommandLineSwitchValue(Electron.app.commandLine, "enable-features"),
        disableFeatures: readCommandLineSwitchValue(Electron.app.commandLine, "disable-features"),
        readHyprctlVersionJson: () =>
          NodeChildProcess.execFileSync("hyprctl", ["version", "-j"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 1000,
            maxBuffer: 64 * 1024,
          }),
      });
      if (disableFeatures !== null) {
        Electron.app.commandLine.appendSwitch("disable-features", disableFeatures);
      }
    }

    return {
      linux,
      linuxPasswordStoreCommandLine,
      ...(desktopSettingsSnapshot === undefined ? {} : { desktopSettingsSnapshot }),
    };
  });
}).pipe(Effect.withSpan("desktop.electron.configureBeforeReady"));

// Complete scheme privileges and switches before later layers can observe app readiness.
export const layer = Layer.mergeAll(
  ElectronProtocol.layerSchemePrivileges,
  Layer.effect(DesktopPreReadyElectronOptions, make),
);
