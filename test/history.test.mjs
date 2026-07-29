import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteMemoryStore } from "../dist/history.js";

test("persists candidate verdicts and recalls tagged research compactly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xpuoj-memory-test-"));
  const originalStateDirectory = process.env.XPUOJ_STATE_DIR;
  process.env.XPUOJ_STATE_DIR = directory;
  const memory = new SqliteMemoryStore(join(directory, "memory.sqlite"));
  try {
    memory.recordSubmitted({
      submissionId: 42,
      target: { kind: "ordinary", displayId: 1 },
      code: "int main() {}",
      codeSha256: "a".repeat(64),
      language: "cpp"
    });
    memory.recordSubmissionDetail({
      meta: {
        id: 42,
        status: "Accepted",
        score: 100,
        displayScore: 77.5,
        submitTime: "2026-07-29T00:00:00Z",
        problem: { displayId: 1 }
      },
      content: { code: "int main() {}", language: "cpp" },
      progress: { progressType: "Finished", compile: { success: true }, testcaseResult: {} }
    });
    const reference = memory.rememberReference({
      kind: "hardware",
      title: "Wave64 scheduling",
      summary: "Use Wave64 only for shapes that map cleanly to 64 lanes.",
      hardware: "MACA C500",
      sourceUrl: "https://example.com/wave64",
      tags: ["C500", "wave64", "attention"]
    });
    const round = memory.planOptimizationRound({
      target: { kind: "ordinary", displayId: 1 },
      hypothesis: "Wave64 maps this shape to a full wavefront.",
      changeSummary: "Use 64 lanes for the aligned route.",
      evidenceIds: [reference.id]
    });
    memory.linkSubmissionToRound(round.id, 42);
    memory.recordSubmissionDetail({
      meta: {
        id: 42,
        status: "Accepted",
        score: 100,
        displayScore: 77.5,
        submitTime: "2026-07-29T00:00:00Z",
        problem: { displayId: 1 }
      },
      content: { code: "int main() {}", language: "cpp" },
      progress: { progressType: "Finished", compile: { success: true }, testcaseResult: {} }
    });
    const experience = memory.distillExperience({
      target: { kind: "ordinary", displayId: 1 },
      hardware: "MACA C500",
      claim: "Use Wave64 only when the shape maps to a full wavefront.",
      confidence: 0.8,
      evidenceRoundIds: [round.id]
    });

    const context = memory.recallForOptimization({
      target: { kind: "ordinary", displayId: 1 },
      query: "C500 attention Wave64",
      hardware: "MACA C500",
      tags: ["C500"]
    });
    assert.equal(context.attempts.attempts, 1);
    assert.equal(context.attempts.best?.submissionId, 42);
    assert.equal(context.attempts.best?.displayScore, 77.5);
    assert.equal(context.research[0]?.record.id, reference.id);
    assert.equal(context.experiences[0]?.id, experience.id);
    assert.ok((context.research[0]?.relevance ?? 0) > 0);
    assert.deepEqual(memory.searchReferences("Wave64", undefined, "C500").map((entry) => entry.id), [reference.id]);
    const exported = memory.exportMemory();
    const importedDirectory = await mkdtemp(join(tmpdir(), "xpuoj-memory-import-test-"));
    const imported = new SqliteMemoryStore(join(importedDirectory, "memory.sqlite"));
    try {
      assert.equal(exported.format, "xpuoj-memory/sqlite-v1");
      assert.equal(imported.importMemory(exported.path).submissions, 1);
      assert.equal(imported.getOptimizationMemory({ kind: "ordinary", displayId: 1 }).best?.submissionId, 42);
    } finally {
      imported.close();
      await rm(importedDirectory, { recursive: true, force: true });
    }
  } finally {
    memory.close();
    if (originalStateDirectory === undefined) delete process.env.XPUOJ_STATE_DIR;
    else process.env.XPUOJ_STATE_DIR = originalStateDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps contest scope when detail exposes a global problem ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xpuoj-memory-contest-test-"));
  const memory = new SqliteMemoryStore(join(directory, "memory.sqlite"));
  try {
    const target = { kind: "contest", contestId: 7, problemOrder: 1 };
    const round = memory.planOptimizationRound({
      target,
      hypothesis: "verify target scope",
      changeSummary: "no source change"
    });
    memory.recordSubmitted({
      submissionId: 99,
      target,
      code: "kernel()",
      codeSha256: "hash",
      language: "tilelang.maca-c500"
    });
    memory.linkSubmissionToRound(round.id, 99);
    memory.recordSubmissionList({
      submissions: [{
        id: 98,
        contestId: 7,
        contestProblemOrder: 1,
        displayScore: 86.86,
        status: "Accepted",
        problem: { order: 1 }
      }]
    });
    memory.recordSubmissionDetail({
      meta: { id: 99, status: "Accepted", displayScore: 85, problem: { displayId: 10003 } },
      content: { code: "kernel()", language: "tilelang.maca-c500" },
      progress: { progressType: "Finished", compile: { success: true } }
    });

    const context = memory.getOptimizationMemory(target);
    assert.equal(context.attempts, 2);
    assert.equal(context.best?.submissionId, 98);
    assert.equal(context.rounds[0]?.decision, "revert");
  } finally {
    memory.close();
    await rm(directory, { recursive: true, force: true });
  }
});
