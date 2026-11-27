import { expect, it } from "vite-plus/test";

import {
  BoundedTerminalHistory,
  type TerminalHistoryPersistenceCursor,
} from "./TerminalHistoryBuffer.ts";

it("tracks UTF-8 byte length in O(1) across multi-byte writes, trims, and clears", () => {
  const history = new BoundedTerminalHistory(500, "", 64);
  const chunks = [
    "hello\n",
    "café ",
    "漢字 ",
    "🚀😀 ",
    "\uFEFFbom\n",
    "x".repeat(40),
    "🚀".repeat(20),
  ];

  for (const chunk of chunks) {
    history.append(chunk);
    expect(history.byteLength).toBe(Buffer.byteLength(history.value(), "utf8"));
    expect(history.byteLength).toBeLessThanOrEqual(64);
  }

  history.clear();
  expect(history.byteLength).toBe(0);
  expect(history.value()).toBe("");
});

it("truncates on valid UTF-8 character boundaries without emitting replacement characters", () => {
  for (const [text, maxBytes, expected] of [
    ["aébc", 4, "ébc"],
    ["aébc", 3, "bc"],
    ["x名yz", 5, "名yz"],
    ["x名yz", 4, "yz"],
    ["x名yz", 3, "yz"],
    ["ab🚀cd", 6, "🚀cd"],
    ["ab🚀cd", 5, "cd"],
    ["ab🚀cd", 4, "cd"],
    ["ab🚀cd", 3, "cd"],
    ["🚀😀🎉", 8, "😀🎉"],
    ["🚀😀🎉", 7, "🎉"],
    ["🚀😀🎉", 3, ""],
  ] as const) {
    const history = new BoundedTerminalHistory(5_000, text, maxBytes);
    const retained = history.value();
    expect(retained).toBe(expected);
    expect(retained).not.toContain("\ufffd");
    expect(history.byteLength).toBe(Buffer.byteLength(retained, "utf8"));
    expect(history.byteLength).toBeLessThanOrEqual(maxBytes);
  }
});

it("drops partial ANSI escape sequences when head trimming lands inside them", () => {
  for (const [text, maxBytes, expected] of [
    ["lead\u001b[38;2;255;0;0mRED", 10, "RED"],
    ["lead\u001b]8;;https://example.com\u0007LINK", 12, "LINK"],
    ["lead\u001bPpayload\u001b\\AFTER", 10, "AFTER"],
    ["lead\u001b_apc-body\u001b\\SHOW", 9, "SHOW"],
    // Non-OSC string ends on emoji's C1 continuation byte, so HELLO is visible text.
    ["lead\u001bP🙂HELLO\u001b\\OK", 9, "HELLO\u001b\\OK"],
  ] as const) {
    const history = new BoundedTerminalHistory(5_000, text, maxBytes);
    expect(history.value()).toBe(expected);
    expect(history.byteLength).toBe(Buffer.byteLength(expected, "utf8"));
  }
});

it("preserves exact UTF-8 and emoji content across multi-slab boundaries", () => {
  const maxBytes = 40_000;
  const history = new BoundedTerminalHistory(5_000, "", maxBytes);
  const first = "a".repeat(16_382) + "🚀" + "b".repeat(16_380) + "名";
  const second = "😀".repeat(4_000) + "tail\n";

  history.append(first);
  expect(history.value()).toBe(first);
  expect(history.byteLength).toBe(Buffer.byteLength(first, "utf8"));

  history.append(second);
  const retained = history.value();
  expect(retained.endsWith(second)).toBe(true);
  expect(retained).not.toContain("\ufffd");
  expect(history.byteLength).toBe(Buffer.byteLength(retained, "utf8"));
  expect(history.byteLength).toBeLessThanOrEqual(maxBytes);
});

it("joins split UTF-16 surrogate pairs across writes and forces rewrite on persistence", () => {
  const history = new BoundedTerminalHistory(50, "", 64);
  history.append("hi\ud83d");
  expect(history.value()).toBe("hi\ud83d");
  expect(history.byteLength).toBe(5);

  const firstFlush = history.persistenceUpdate();
  expect(firstFlush.append).toBe(false);

  history.append("\ude80!");
  expect(history.value()).toBe("hi🚀!");
  expect(history.byteLength).toBe(7);

  const secondFlush = history.persistenceUpdate(firstFlush.cursor);
  expect(secondFlush.append).toBe(false);
  expect(secondFlush.data).toBe("hi🚀!");
  expect(secondFlush.cursor.fileBytes).toBe(7);
});

it("keeps persisted plain UTF-8 logs backwards compatible across appends and compactions", () => {
  const maxBytes = 128;
  const maxLines = 4;
  const history = new BoundedTerminalHistory(maxLines, "", maxBytes);
  let cursor: TerminalHistoryPersistenceCursor | undefined;
  let diskBytes = Buffer.alloc(0);
  let appends = 0;
  let rewrites = 0;

  for (let index = 0; index < 40; index += 1) {
    history.append(`row-${index} café 🚀\n`);
    const update = history.persistenceUpdate(cursor);
    const encoded = Buffer.from(update.data, "utf8");
    if (update.append) {
      appends += 1;
      diskBytes = Buffer.concat([diskBytes, encoded]);
    } else {
      rewrites += 1;
      diskBytes = encoded;
    }
    cursor = update.cursor;
    expect(diskBytes.byteLength).toBe(cursor.fileBytes);
    expect(diskBytes.byteLength).toBeLessThanOrEqual(maxBytes * 2);

    const reloaded = new BoundedTerminalHistory(maxLines, diskBytes.toString("utf8"), maxBytes);
    expect(reloaded.value()).toBe(history.value());
  }

  expect(appends).toBeGreaterThan(0);
  expect(rewrites).toBeGreaterThan(1);
});
