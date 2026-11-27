import { useSyncExternalStore } from "react";

import { getThemeBackgroundUrl, subscribeThemeBackgroundUrl } from "./themeBackground";

const WALLPAPER_DB_NAME = "zerocode-chat-wallpaper";
const WALLPAPER_STORE_NAME = "images";
const WALLPAPER_RECORD_KEY = "current";
const WALLPAPER_CHANNEL_NAME = "zerocode-chat-wallpaper-sync";
const MAX_CUSTOM_WALLPAPER_BYTES = 16 * 1024 * 1024;

interface CustomWallpaperState {
  readonly url: string | null;
  readonly name: string | null;
}

const EMPTY_CUSTOM_WALLPAPER: CustomWallpaperState = { url: null, name: null };

let customState: CustomWallpaperState = EMPTY_CUSTOM_WALLPAPER;
let hydrated = false;
let hydrating: Promise<void> | null = null;
let broadcastChannel: BroadcastChannel | null = null;
const customListeners = new Set<() => void>();

function emitCustomChange(): void {
  for (const listener of customListeners) {
    listener();
  }
}

function replaceCustomWallpaper(nextUrl: string | null, nextName: string | null): void {
  const prevUrl = customState.url;
  if (prevUrl === nextUrl && customState.name === nextName) return;
  customState = nextUrl === null ? EMPTY_CUSTOM_WALLPAPER : { url: nextUrl, name: nextName };
  if (prevUrl !== null && prevUrl !== nextUrl) {
    URL.revokeObjectURL(prevUrl);
  }
  emitCustomChange();
}

function openWallpaperDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(WALLPAPER_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WALLPAPER_STORE_NAME)) {
        db.createObjectStore(WALLPAPER_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function readStoredWallpaperRecord(): Promise<{ blob: Blob; name: string | null } | null> {
  const db = await openWallpaperDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(WALLPAPER_STORE_NAME, "readonly");
    const req = tx.objectStore(WALLPAPER_STORE_NAME).get(WALLPAPER_RECORD_KEY);
    req.onsuccess = () => {
      db.close();
      const value = req.result as { blob?: unknown; name?: unknown } | undefined;
      if (value && value.blob instanceof Blob) {
        resolve({
          blob: value.blob,
          name: typeof value.name === "string" ? value.name : null,
        });
        return;
      }
      resolve(null);
    };
    req.onerror = () => {
      db.close();
      resolve(null);
    };
  });
}

async function writeStoredWallpaperRecord(
  record: { blob: Blob; name: string } | null,
): Promise<boolean> {
  const db = await openWallpaperDb();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction(WALLPAPER_STORE_NAME, "readwrite");
    const store = tx.objectStore(WALLPAPER_STORE_NAME);
    if (record === null) store.delete(WALLPAPER_RECORD_KEY);
    else store.put(record, WALLPAPER_RECORD_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve(true);
    };
    tx.onerror = () => {
      db.close();
      resolve(false);
    };
  });
}

function ensureBroadcastSync(): void {
  if (broadcastChannel !== null || typeof BroadcastChannel === "undefined") return;
  broadcastChannel = new BroadcastChannel(WALLPAPER_CHANNEL_NAME);
  broadcastChannel.onmessage = () => {
    hydrated = false;
    void hydrateCustomWallpaper();
  };
}

function notifyOtherTabs(): void {
  ensureBroadcastSync();
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel.postMessage takes only a single message argument.
  broadcastChannel?.postMessage("updated");
}

function hydrateCustomWallpaper(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (hydrating !== null) return hydrating;
  ensureBroadcastSync();
  hydrating = readStoredWallpaperRecord().then((record) => {
    hydrated = true;
    hydrating = null;
    if (record !== null) {
      replaceCustomWallpaper(URL.createObjectURL(record.blob), record.name);
    } else {
      replaceCustomWallpaper(null, null);
    }
  });
  return hydrating;
}

function subscribeCustomWallpaper(listener: () => void): () => void {
  customListeners.add(listener);
  void hydrateCustomWallpaper();
  return () => {
    customListeners.delete(listener);
  };
}

function getCustomWallpaperSnapshot(): CustomWallpaperState {
  return customState;
}

export async function setCustomChatWallpaper(
  file: Blob,
  name = "wallpaper",
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly reason: "invalid-type" | "too-large" }
> {
  if (!file.type.startsWith("image/")) {
    return { ok: false, reason: "invalid-type" };
  }
  if (file.size > MAX_CUSTOM_WALLPAPER_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  const url = URL.createObjectURL(file);
  hydrated = true;
  replaceCustomWallpaper(url, name);
  await writeStoredWallpaperRecord({ blob: file, name });
  notifyOtherTabs();
  return { ok: true };
}

export async function clearCustomChatWallpaper(): Promise<void> {
  hydrated = true;
  replaceCustomWallpaper(null, null);
  await writeStoredWallpaperRecord(null);
  notifyOtherTabs();
}

export function useChatWallpaper(): {
  readonly url: string | null;
  readonly source: "custom" | "theme" | "none";
  readonly customName: string | null;
} {
  const custom = useSyncExternalStore(
    subscribeCustomWallpaper,
    getCustomWallpaperSnapshot,
    () => EMPTY_CUSTOM_WALLPAPER,
  );
  const themeUrl = useSyncExternalStore(
    subscribeThemeBackgroundUrl,
    getThemeBackgroundUrl,
    () => null,
  );
  if (custom.url !== null) {
    return { url: custom.url, source: "custom", customName: custom.name };
  }
  if (themeUrl !== null) {
    return { url: themeUrl, source: "theme", customName: null };
  }
  return { url: null, source: "none", customName: null };
}
