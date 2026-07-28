import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  decodeSnappyBlock,
  resolveChromiumTokenFromDirectory,
  resolveSafariTokenFromDatabase
} from "../dist/browser-auth.js";

test("decodes an uncompressed Snappy Firefox local-storage block", () => {
  const source = Uint8Array.from([3, 8, 97, 98, 99]);
  assert.deepEqual([...decodeSnappyBlock(source)], [97, 98, 99]);
});

test("reads XPUOJ session data from a Safari local-storage database only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xpuoj-safari-"));
  const databasePath = join(directory, "https_xpuoj.com_0.localstorage");
  try {
    const database = new DatabaseSync(databasePath, { allowExtension: false });
    try {
      database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB NOT NULL)");
      database
        .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
        .run("appState", Buffer.from('{\"token\":\"xpuoj-safari-token\"}'));
    } finally {
      database.close();
    }
    assert.equal(resolveSafariTokenFromDatabase(databasePath), "xpuoj-safari-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads XPUOJ appState from Chromium local-storage data only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xpuoj-chromium-"));
  try {
    await writeFile(
      join(directory, "000003.ldb"),
      Buffer.from(
        `META:other.example\u0000appState{"token":"must-not-read"}` +
          `_https://xpuoj.com\u0000appState{"token":"xpuoj-test-token"}`
      )
    );
    assert.equal(resolveChromiumTokenFromDirectory(directory), "xpuoj-test-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
