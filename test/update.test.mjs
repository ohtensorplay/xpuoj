import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkForUpdate, compareVersions } from "../dist/update.js";

test("compares stable and prerelease semantic versions", () => {
  assert.ok(compareVersions("0.3.5", "0.3.4") > 0);
  assert.ok(compareVersions("0.3.4", "0.3.4-rc.1") > 0);
  assert.ok(compareVersions("0.3.4-rc.2", "0.3.4-rc.10") < 0);
});

test("caches the latest GitHub release without failing commands on network errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xpuoj-update-"));
  const cachePath = join(directory, "update.json");
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ tag_name: "v0.3.5" }) };
  };
  try {
    const first = await checkForUpdate("0.3.4", {
      cachePath,
      fetchFn,
      now: 1_000
    });
    const second = await checkForUpdate("0.3.4", {
      cachePath,
      fetchFn: async () => {
        throw new Error("cache should prevent a second request");
      },
      now: 2_000
    });
    const unavailable = await checkForUpdate("0.3.4", {
      cachePath: join(directory, "unavailable.json"),
      fetchFn: async () => {
        throw new Error("offline");
      },
      now: 1_000
    });
    assert.equal(calls, 1);
    assert.deepEqual(first, {
      latestVersion: "0.3.5",
      updateAvailable: true,
      source: "network"
    });
    assert.deepEqual(second, {
      latestVersion: "0.3.5",
      updateAvailable: true,
      source: "cache"
    });
    assert.deepEqual(unavailable, { updateAvailable: false, source: "unavailable" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
