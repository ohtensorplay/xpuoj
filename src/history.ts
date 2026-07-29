import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isRecord, type JsonObject, type ProblemTarget } from "./core.js";

export type ResearchKind = "hardware" | "algorithm" | "benchmark" | "note";

export interface SubmissionMemoryRecord {
  submissionId: number;
  target: string;
  status: string | null;
  score: number | null;
  displayScore: number | null;
  language: string | null;
  codeSha256: string | null;
  submittedAt: string | null;
  updatedAt: number;
}

export interface ResearchMemoryRecord {
  id: number;
  kind: ResearchKind;
  title: string;
  summary: string;
  hardware: string | null;
  sourceUrl: string | null;
  tags: string[];
  updatedAt: number;
}

export interface OptimizationMemory {
  target: string | null;
  attempts: number;
  finished: number;
  accepted: number;
  best: SubmissionMemoryRecord | null;
  recent: SubmissionMemoryRecord[];
  rounds: OptimizationRoundRecord[];
}

export interface OptimizationRoundRecord {
  id: number;
  target: string;
  hypothesis: string;
  changeSummary: string;
  evidenceIds: number[];
  submissionId: number | null;
  outcome: string | null;
  displayScore: number | null;
  decision: "pending" | "keep" | "equivalent" | "revert" | "accepted";
  updatedAt: number;
}

export interface ResearchRecall {
  record: ResearchMemoryRecord;
  relevance: number;
  matched: string[];
}

export interface OptimizationRecall {
  attempts: OptimizationMemory;
  research: ResearchRecall[];
  experiences: ExperienceRecord[];
}

export interface ExperienceRecord {
  id: number;
  target: string | null;
  hardware: string | null;
  claim: string;
  confidence: number;
  evidenceRoundIds: number[];
  supersedesId: number | null;
  state: "active" | "superseded";
  updatedAt: number;
}

export interface MemoryExportInfo {
  path: string;
  sha256: string;
  submissions: number;
  research: number;
  rounds: number;
  experiences: number;
  format: "xpuoj-memory/sqlite-v1";
}

export interface MemoryImportInfo {
  submissions: number;
  research: number;
  rounds: number;
  experiences: number;
}

export interface LocalMemoryStore {
  recordSubmitted(input: {
    submissionId: number;
    target: ProblemTarget;
    code: string;
    codeSha256: string;
    language: string;
  }): void;
  recordSubmissionDetail(detail: JsonObject): void;
  recordSubmissionList(response: JsonObject): void;
  planOptimizationRound(input: {
    target: ProblemTarget;
    hypothesis: string;
    changeSummary: string;
    evidenceIds?: number[];
  }): OptimizationRoundRecord;
  linkSubmissionToRound(roundId: number, submissionId: number): void;
  getOptimizationMemory(target?: ProblemTarget, limit?: number): OptimizationMemory;
  rememberReference(input: {
    kind: ResearchKind;
    title: string;
    summary: string;
    hardware?: string;
    sourceUrl?: string;
    tags?: string[];
  }): ResearchMemoryRecord;
  searchReferences(query?: string, kind?: ResearchKind, hardware?: string, limit?: number): ResearchMemoryRecord[];
  recallForOptimization(input: {
    target?: ProblemTarget;
    query?: string;
    hardware?: string;
    tags?: string[];
    limit?: number;
  }): OptimizationRecall;
  distillExperience(input: {
    target?: ProblemTarget;
    hardware?: string;
    claim: string;
    confidence: number;
    evidenceRoundIds: number[];
    supersedesId?: number;
  }): ExperienceRecord;
  exportMemory(): MemoryExportInfo;
  importMemory(path: string): MemoryImportInfo;
  close(): void;
}

function stateDirectory(): string {
  return process.env.XPUOJ_STATE_DIR?.trim() || process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
}

export function defaultHistoryPath(): string {
  return join(stateDirectory(), "xpuoj", "memory.sqlite");
}

function defaultExportPath(): string {
  const directory = join(stateDirectory(), "xpuoj", "exports");
  prepareDirectory(directory);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(directory, `memory-${stamp}.sqlite`);
}

function prepareDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Filesystems without POSIX modes still retain the platform default permissions.
  }
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function targetKey(target: ProblemTarget): string {
  return target.kind === "ordinary"
    ? `/p/${target.displayId}`
    : `/contest/${target.contestId}/problem/${target.problemOrder}`;
}

function targetFromDetail(detail: JsonObject): string | null {
  const meta = isRecord(detail.meta) ? detail.meta : {};
  const problem = isRecord(meta.problem) ? meta.problem : {};
  const displayId = asNullableNumber(problem.displayId);
  return displayId === null ? null : `/p/${displayId}`;
}

function submissionId(detail: JsonObject): number | null {
  const meta = isRecord(detail.meta) ? detail.meta : {};
  return asNullableNumber(meta.id);
}

function boundedJson(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= 16_000 ? serialized : `${serialized.slice(0, 15_997)}...`;
  } catch {
    return null;
  }
}

function tagsToString(tags: string[] | undefined): string {
  return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))].join(",");
}

function tagsFromString(tags: string | null): string[] {
  return tags ? tags.split(",").filter(Boolean) : [];
}

function validResearchKind(value: string): value is ResearchKind {
  return value === "hardware" || value === "algorithm" || value === "benchmark" || value === "note";
}

function clampLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 50 ? limit : fallback;
}

function terms(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^\p{L}\p{N}_+.-]+/u).filter((term) => term.length >= 2))];
}

function recencyBoost(updatedAt: number): number {
  const ageDays = Math.max(0, (Date.now() - updatedAt) / 86_400_000);
  return Math.max(0, 1 - ageDays / 180);
}

function submissionRecord(row: unknown): SubmissionMemoryRecord {
  const value = isRecord(row) ? row : {};
  return {
    submissionId: asNullableNumber(value.submission_id) ?? 0,
    target: asNullableString(value.target_key) ?? "unknown",
    status: asNullableString(value.status),
    score: asNullableNumber(value.score),
    displayScore: asNullableNumber(value.display_score),
    language: asNullableString(value.language),
    codeSha256: asNullableString(value.code_sha256),
    submittedAt: asNullableString(value.submitted_at),
    updatedAt: asNullableNumber(value.updated_at) ?? 0
  };
}

function researchRecord(row: unknown): ResearchMemoryRecord {
  const value = isRecord(row) ? row : {};
  const kind = asNullableString(value.kind);
  return {
    id: asNullableNumber(value.id) ?? 0,
    kind: kind && validResearchKind(kind) ? kind : "note",
    title: asNullableString(value.title) ?? "Untitled",
    summary: asNullableString(value.summary) ?? "",
    hardware: asNullableString(value.hardware),
    sourceUrl: asNullableString(value.source_url),
    tags: tagsFromString(asNullableString(value.tags)),
    updatedAt: asNullableNumber(value.updated_at) ?? 0
  };
}

function idsFromString(value: string | null): number[] {
  return (value ?? "").split(",").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
}

function roundRecord(row: unknown): OptimizationRoundRecord {
  const value = isRecord(row) ? row : {};
  const rawDecision = asNullableString(value.decision);
  const decision = rawDecision === "keep" || rawDecision === "equivalent" || rawDecision === "revert" || rawDecision === "accepted"
    ? rawDecision
    : "pending";
  return {
    id: asNullableNumber(value.id) ?? 0,
    target: asNullableString(value.target_key) ?? "unknown",
    hypothesis: asNullableString(value.hypothesis) ?? "",
    changeSummary: asNullableString(value.change_summary) ?? "",
    evidenceIds: idsFromString(asNullableString(value.evidence_ids)),
    submissionId: asNullableNumber(value.submission_id),
    outcome: asNullableString(value.outcome),
    displayScore: asNullableNumber(value.display_score),
    decision,
    updatedAt: asNullableNumber(value.updated_at) ?? 0
  };
}

function experienceRecord(row: unknown): ExperienceRecord {
  const value = isRecord(row) ? row : {};
  return {
    id: asNullableNumber(value.id) ?? 0,
    target: asNullableString(value.target_key),
    hardware: asNullableString(value.hardware),
    claim: asNullableString(value.claim) ?? "",
    confidence: asNullableNumber(value.confidence) ?? 0,
    evidenceRoundIds: idsFromString(asNullableString(value.evidence_round_ids)),
    supersedesId: asNullableNumber(value.supersedes_id),
    state: asNullableString(value.state) === "superseded" ? "superseded" : "active",
    updatedAt: asNullableNumber(value.updated_at) ?? 0
  };
}

export class SqliteMemoryStore implements LocalMemoryStore {
  private readonly database: DatabaseSync;
  private readonly path: string;

  constructor(path = defaultHistoryPath()) {
    prepareDirectory(join(path, ".."));
    this.path = path;
    this.database = new DatabaseSync(path, { allowExtension: false, timeout: 3_000 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort on non-POSIX filesystems.
    }
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS submission_memory (
        submission_id INTEGER PRIMARY KEY,
        target_key TEXT,
        language TEXT,
        source_code TEXT,
        code_sha256 TEXT,
        status TEXT,
        score REAL,
        display_score REAL,
        time_used REAL,
        memory_used REAL,
        progress_type TEXT,
        compile_success INTEGER,
        compile_message TEXT,
        diagnostics TEXT,
        submitted_at TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS submission_memory_target_updated
        ON submission_memory(target_key, updated_at DESC);
      CREATE TABLE IF NOT EXISTS research_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        hardware TEXT,
        source_url TEXT,
        tags TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS research_memory_kind_updated
        ON research_memory(kind, updated_at DESC);
      CREATE TABLE IF NOT EXISTS optimization_rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_key TEXT NOT NULL,
        hypothesis TEXT NOT NULL,
        change_summary TEXT NOT NULL,
        evidence_ids TEXT NOT NULL DEFAULT '',
        submission_id INTEGER UNIQUE,
        outcome TEXT,
        display_score REAL,
        decision TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS optimization_rounds_target_updated
        ON optimization_rounds(target_key, updated_at DESC);
      CREATE TABLE IF NOT EXISTS experience_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_key TEXT,
        hardware TEXT,
        claim TEXT NOT NULL,
        confidence REAL NOT NULL,
        evidence_round_ids TEXT NOT NULL,
        supersedes_id INTEGER,
        state TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS experience_memory_scope_updated
        ON experience_memory(target_key, hardware, state, updated_at DESC);
      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR REPLACE INTO memory_meta (key, value) VALUES
        ('format', 'xpuoj-memory/sqlite-v1'),
        ('schema_version', '1');
    `);
    try {
      this.database.exec("ALTER TABLE research_memory ADD COLUMN hardware TEXT");
    } catch {
      // Existing stores already have the column, or SQLite has no migration work to do.
    }
  }

  recordSubmitted(input: {
    submissionId: number;
    target: ProblemTarget;
    code: string;
    codeSha256: string;
    language: string;
  }): void {
    const now = Date.now();
    this.database.prepare(`
      INSERT INTO submission_memory (
        submission_id, target_key, language, source_code, code_sha256, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'Submitted', ?)
      ON CONFLICT(submission_id) DO UPDATE SET
        target_key = excluded.target_key,
        language = excluded.language,
        source_code = excluded.source_code,
        code_sha256 = excluded.code_sha256,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(input.submissionId, targetKey(input.target), input.language, input.code, input.codeSha256, now);
  }

  recordSubmissionDetail(detail: JsonObject): void {
    const id = submissionId(detail);
    if (id === null) {
      return;
    }
    const meta = isRecord(detail.meta) ? detail.meta : {};
    const progress = isRecord(detail.progress) ? detail.progress : {};
    const compile = isRecord(progress.compile) ? progress.compile : {};
    const content = isRecord(detail.content) ? detail.content : {};
    const source = asNullableString(content.code);
    const language = asNullableString(content.language) ?? asNullableString(meta.codeLanguage);
    const diagnostics = boundedJson({
      compile: compile.message,
      testcases: progress.testcaseResult
    });
    const now = Date.now();
    this.database.prepare(`
      INSERT INTO submission_memory (
        submission_id, target_key, language, source_code, status, score, display_score,
        time_used, memory_used, progress_type, compile_success, compile_message, diagnostics,
        submitted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(submission_id) DO UPDATE SET
        target_key = COALESCE(submission_memory.target_key, excluded.target_key),
        language = COALESCE(excluded.language, submission_memory.language),
        source_code = COALESCE(excluded.source_code, submission_memory.source_code),
        status = COALESCE(excluded.status, submission_memory.status),
        score = COALESCE(excluded.score, submission_memory.score),
        display_score = COALESCE(excluded.display_score, submission_memory.display_score),
        time_used = COALESCE(excluded.time_used, submission_memory.time_used),
        memory_used = COALESCE(excluded.memory_used, submission_memory.memory_used),
        progress_type = COALESCE(excluded.progress_type, submission_memory.progress_type),
        compile_success = COALESCE(excluded.compile_success, submission_memory.compile_success),
        compile_message = COALESCE(excluded.compile_message, submission_memory.compile_message),
        diagnostics = COALESCE(excluded.diagnostics, submission_memory.diagnostics),
        submitted_at = COALESCE(excluded.submitted_at, submission_memory.submitted_at),
        updated_at = excluded.updated_at
    `).run(
      id,
      targetFromDetail(detail),
      language,
      source,
      asNullableString(meta.status),
      asNullableNumber(meta.score),
      asNullableNumber(meta.displayScore),
      asNullableNumber(meta.timeUsed),
      asNullableNumber(meta.memoryUsed),
      asNullableString(progress.progressType),
      compile.success === true ? 1 : compile.success === false ? 0 : null,
      asNullableString(compile.message),
      diagnostics,
      asNullableString(meta.submitTime),
      now
    );
    const linkedRound = this.database.prepare(`
      SELECT target_key FROM optimization_rounds WHERE submission_id = ? LIMIT 1
    `).get(id);
    const linkedTarget = isRecord(linkedRound) ? asNullableString(linkedRound.target_key) : null;
    this.updateRoundOutcome(
      id,
      linkedTarget ?? targetFromDetail(detail),
      asNullableString(meta.status),
      asNullableNumber(meta.displayScore),
      asNullableString(progress.progressType)
    );
  }

  recordSubmissionList(response: JsonObject): void {
    const submissions = Array.isArray(response.submissions) ? response.submissions.filter(isRecord) : [];
    const statement = this.database.prepare(`
      INSERT INTO submission_memory (
        submission_id, target_key, language, status, score, display_score, time_used,
        memory_used, submitted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(submission_id) DO UPDATE SET
        target_key = COALESCE(excluded.target_key, submission_memory.target_key),
        language = COALESCE(excluded.language, submission_memory.language),
        status = COALESCE(excluded.status, submission_memory.status),
        score = COALESCE(excluded.score, submission_memory.score),
        display_score = COALESCE(excluded.display_score, submission_memory.display_score),
        time_used = COALESCE(excluded.time_used, submission_memory.time_used),
        memory_used = COALESCE(excluded.memory_used, submission_memory.memory_used),
        submitted_at = COALESCE(excluded.submitted_at, submission_memory.submitted_at),
        updated_at = excluded.updated_at
    `);
    const now = Date.now();
    for (const entry of submissions) {
      const problem = isRecord(entry.problem) ? entry.problem : {};
      const displayId = asNullableNumber(problem.displayId);
      const contestId = asNullableNumber(entry.contestId);
      const contestProblemOrder = asNullableNumber(entry.contestProblemOrder) ?? asNullableNumber(problem.order);
      const id = asNullableNumber(entry.id);
      if (id === null) {
        continue;
      }
      statement.run(
        id,
        contestId !== null && contestProblemOrder !== null
          ? `/contest/${contestId}/problem/${contestProblemOrder}`
          : displayId === null
            ? null
            : `/p/${displayId}`,
        asNullableString(entry.codeLanguage),
        asNullableString(entry.status),
        asNullableNumber(entry.score),
        asNullableNumber(entry.displayScore),
        asNullableNumber(entry.timeUsed),
        asNullableNumber(entry.memoryUsed),
        asNullableString(entry.submitTime),
        now
      );
    }
  }

  planOptimizationRound(input: {
    target: ProblemTarget;
    hypothesis: string;
    changeSummary: string;
    evidenceIds?: number[];
  }): OptimizationRoundRecord {
    const hypothesis = input.hypothesis.trim();
    const changeSummary = input.changeSummary.trim();
    if (!hypothesis || !changeSummary) {
      throw new Error("optimization hypothesis and change summary are required");
    }
    const now = Date.now();
    const evidenceIds = [...new Set((input.evidenceIds ?? []).filter((id) => Number.isSafeInteger(id) && id > 0))];
    const result = this.database.prepare(`
      INSERT INTO optimization_rounds (
        target_key, hypothesis, change_summary, evidence_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(targetKey(input.target), hypothesis, changeSummary, evidenceIds.join(","), now, now);
    const row = this.database.prepare("SELECT * FROM optimization_rounds WHERE id = ?").get(result.lastInsertRowid);
    return roundRecord(row);
  }

  linkSubmissionToRound(roundId: number, submissionId: number): void {
    const result = this.database.prepare(`
      UPDATE optimization_rounds SET submission_id = ?, updated_at = ?
      WHERE id = ? AND submission_id IS NULL
    `).run(submissionId, Date.now(), roundId);
    if (result.changes !== 1) {
      throw new Error("optimization round is missing or already linked to a submission");
    }
  }

  private updateRoundOutcome(
    submissionId: number,
    target: string | null,
    status: string | null,
    displayScore: number | null,
    progressType: string | null
  ): void {
    const existing = this.database.prepare("SELECT id FROM optimization_rounds WHERE submission_id = ?").get(submissionId);
    if (!existing) {
      return;
    }
    let decision: OptimizationRoundRecord["decision"] = "pending";
    if (progressType === "Finished") {
      if (status !== "Accepted") {
        decision = "revert";
      } else if (displayScore === null || target === null) {
        decision = "accepted";
      } else {
        const baseline = this.database.prepare(`
          SELECT MAX(display_score) AS score FROM submission_memory
          WHERE target_key = ? AND submission_id <> ?
        `).get(target, submissionId);
        const bestPrevious = asNullableNumber(isRecord(baseline) ? baseline.score : undefined);
        decision = bestPrevious === null || displayScore > bestPrevious
          ? "keep"
          : displayScore === bestPrevious
            ? "equivalent"
            : "revert";
      }
    }
    this.database.prepare(`
      UPDATE optimization_rounds
      SET outcome = ?, display_score = ?, decision = ?, updated_at = ?
      WHERE submission_id = ?
    `).run(status, displayScore, decision, Date.now(), submissionId);
  }

  getOptimizationMemory(target?: ProblemTarget, limit?: number): OptimizationMemory {
    const normalizedLimit = clampLimit(limit, 12);
    const key = target ? targetKey(target) : null;
    const rows = key
      ? this.database.prepare(`
          SELECT * FROM submission_memory WHERE target_key = ?
          ORDER BY COALESCE(submitted_at, '' ) DESC, submission_id DESC LIMIT ?
        `).all(key, normalizedLimit)
      : this.database.prepare(`
          SELECT * FROM submission_memory
          ORDER BY COALESCE(submitted_at, '' ) DESC, submission_id DESC LIMIT ?
        `).all(normalizedLimit);
    const records = rows.map(submissionRecord);
    const total = key
      ? this.database.prepare("SELECT COUNT(*) AS count FROM submission_memory WHERE target_key = ?").get(key)
      : this.database.prepare("SELECT COUNT(*) AS count FROM submission_memory").get();
    const finished = key
      ? this.database.prepare("SELECT COUNT(*) AS count FROM submission_memory WHERE target_key = ? AND progress_type = 'Finished'").get(key)
      : this.database.prepare("SELECT COUNT(*) AS count FROM submission_memory WHERE progress_type = 'Finished'").get();
    const accepted = key
      ? this.database.prepare("SELECT COUNT(*) AS count FROM submission_memory WHERE target_key = ? AND status = 'Accepted'").get(key)
      : this.database.prepare("SELECT COUNT(*) AS count FROM submission_memory WHERE status = 'Accepted'").get();
    const best = key
      ? this.database.prepare(`
          SELECT * FROM submission_memory WHERE target_key = ? AND display_score IS NOT NULL
          ORDER BY display_score DESC, submission_id DESC LIMIT 1
        `).get(key)
      : this.database.prepare(`
          SELECT * FROM submission_memory WHERE display_score IS NOT NULL
          ORDER BY display_score DESC, submission_id DESC LIMIT 1
        `).get();
    const rounds = key
      ? this.database.prepare(`
          SELECT * FROM optimization_rounds WHERE target_key = ?
          ORDER BY updated_at DESC, id DESC LIMIT 8
        `).all(key).map(roundRecord)
      : this.database.prepare(`
          SELECT * FROM optimization_rounds
          ORDER BY updated_at DESC, id DESC LIMIT 8
        `).all().map(roundRecord);
    return {
      target: key,
      attempts: asNullableNumber(isRecord(total) ? total.count : undefined) ?? 0,
      finished: asNullableNumber(isRecord(finished) ? finished.count : undefined) ?? 0,
      accepted: asNullableNumber(isRecord(accepted) ? accepted.count : undefined) ?? 0,
      best: best ? submissionRecord(best) : null,
      recent: records,
      rounds
    };
  }

  rememberReference(input: {
    kind: ResearchKind;
    title: string;
    summary: string;
    hardware?: string;
    sourceUrl?: string;
    tags?: string[];
  }): ResearchMemoryRecord {
    const title = input.title.trim();
    const summary = input.summary.trim();
    if (!title || !summary) {
      throw new Error("reference title and summary are required");
    }
    const now = Date.now();
    const result = this.database.prepare(`
      INSERT INTO research_memory (kind, title, summary, hardware, source_url, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.kind,
      title,
      summary,
      input.hardware?.trim() || null,
      input.sourceUrl?.trim() || null,
      tagsToString(input.tags),
      now,
      now
    );
    const row = this.database.prepare("SELECT * FROM research_memory WHERE id = ?").get(result.lastInsertRowid);
    return researchRecord(row);
  }

  searchReferences(query?: string, kind?: ResearchKind, hardware?: string, limit?: number): ResearchMemoryRecord[] {
    const normalizedLimit = clampLimit(limit, 10);
    const text = query?.trim() ?? "";
    const clause = text ? " AND (title LIKE ? OR summary LIKE ? OR hardware LIKE ? OR tags LIKE ? OR source_url LIKE ?)" : "";
    const typeClause = kind ? "kind = ?" : "1 = 1";
    const hardwareClause = hardware?.trim() ? " AND hardware LIKE ?" : "";
    const statement = this.database.prepare(`
      SELECT * FROM research_memory WHERE ${typeClause}${hardwareClause}${clause}
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `);
    const values: (string | number)[] = kind ? [kind] : [];
    if (hardware?.trim()) {
      values.push(`%${hardware.trim()}%`);
    }
    if (text) {
      const pattern = `%${text}%`;
      values.push(pattern, pattern, pattern, pattern, pattern);
    }
    values.push(normalizedLimit);
    return statement.all(...values).map(researchRecord);
  }

  recallForOptimization(input: {
    target?: ProblemTarget;
    query?: string;
    hardware?: string;
    tags?: string[];
    limit?: number;
  }): OptimizationRecall {
    const limit = clampLimit(input.limit, 8);
    const attemptMemory = this.getOptimizationMemory(input.target, limit);
    const query = [
      input.query?.trim() ?? "",
      input.target ? targetKey(input.target) : "",
      input.hardware?.trim() ?? "",
      ...(input.tags ?? [])
    ].filter(Boolean).join(" ");
    const queryTerms = terms(query);
    const rows = this.database.prepare(`
      SELECT * FROM research_memory ORDER BY updated_at DESC, id DESC LIMIT 200
    `).all().map(researchRecord);
    const research = rows.map((record) => {
      const title = record.title.toLowerCase();
      const summary = record.summary.toLowerCase();
      const tags = record.tags.map((tag) => tag.toLowerCase());
      const hardware = record.hardware?.toLowerCase() ?? "";
      const matched: string[] = [];
      let relevance = recencyBoost(record.updatedAt);
      for (const term of queryTerms) {
        if (title.includes(term)) {
          relevance += 7;
          matched.push(term);
        } else if (tags.some((tag) => tag.includes(term))) {
          relevance += 5;
          matched.push(term);
        } else if (summary.includes(term)) {
          relevance += 2;
          matched.push(term);
        } else if (hardware.includes(term)) {
          relevance += 5;
          matched.push(term);
        }
      }
      return { record, relevance, matched: [...new Set(matched)] };
    }).filter((candidate) => candidate.relevance > 1 || (!queryTerms.length && candidate.relevance > 0));
    research.sort((left, right) => right.relevance - left.relevance || right.record.updatedAt - left.record.updatedAt);
    const scope = input.target ? targetKey(input.target) : null;
    const experiences = this.database.prepare(`
      SELECT * FROM experience_memory WHERE state = 'active'
      ORDER BY updated_at DESC, id DESC LIMIT 100
    `).all().map(experienceRecord).map((experience) => {
      let relevance = recencyBoost(experience.updatedAt) + experience.confidence * 4;
      if (scope && experience.target === scope) relevance += 8;
      if (input.hardware?.trim() && experience.hardware?.toLowerCase().includes(input.hardware.trim().toLowerCase())) relevance += 6;
      const claim = experience.claim.toLowerCase();
      relevance += queryTerms.filter((term) => claim.includes(term)).length * 3;
      return { experience, relevance };
    }).filter((item) => item.relevance > 1);
    experiences.sort((left, right) => right.relevance - left.relevance || right.experience.updatedAt - left.experience.updatedAt);
    return { attempts: attemptMemory, research: research.slice(0, limit), experiences: experiences.slice(0, limit).map((item) => item.experience) };
  }

  distillExperience(input: {
    target?: ProblemTarget;
    hardware?: string;
    claim: string;
    confidence: number;
    evidenceRoundIds: number[];
    supersedesId?: number;
  }): ExperienceRecord {
    const claim = input.claim.trim();
    if (!claim) throw new Error("experience claim is required");
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new Error("experience confidence must be between 0 and 1");
    }
    const evidence = [...new Set(input.evidenceRoundIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (!evidence.length) throw new Error("at least one official optimization round is required");
    const placeholders = evidence.map(() => "?").join(",");
    const verified = this.database.prepare(`
      SELECT COUNT(*) AS count FROM optimization_rounds
      WHERE id IN (${placeholders}) AND decision <> 'pending'
    `).get(...evidence);
    if ((asNullableNumber(isRecord(verified) ? verified.count : undefined) ?? 0) !== evidence.length) {
      throw new Error("every evidence round must be linked to an official terminal verdict");
    }
    const now = Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (input.supersedesId !== undefined) {
        const result = this.database.prepare(`
          UPDATE experience_memory SET state = 'superseded', updated_at = ?
          WHERE id = ? AND state = 'active'
        `).run(now, input.supersedesId);
        if (result.changes !== 1) throw new Error("experience to supersede is missing or already superseded");
      }
      const result = this.database.prepare(`
        INSERT INTO experience_memory (
          target_key, hardware, claim, confidence, evidence_round_ids, supersedes_id, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        input.target ? targetKey(input.target) : null,
        input.hardware?.trim() || null,
        claim,
        input.confidence,
        evidence.join(","),
        input.supersedesId ?? null,
        now,
        now
      );
      const row = this.database.prepare("SELECT * FROM experience_memory WHERE id = ?").get(result.lastInsertRowid);
      this.database.exec("COMMIT");
      return experienceRecord(row);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  exportMemory(): MemoryExportInfo {
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const path = defaultExportPath();
    copyFileSync(this.path, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort on non-POSIX filesystems.
    }
    const binary = readFileSync(path);
    const count = (table: string): number => {
      const row = this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      return asNullableNumber(isRecord(row) ? row.count : undefined) ?? 0;
    };
    return {
      path,
      sha256: createHash("sha256").update(binary).digest("hex"),
      submissions: count("submission_memory"),
      research: count("research_memory"),
      rounds: count("optimization_rounds"),
      experiences: count("experience_memory"),
      format: "xpuoj-memory/sqlite-v1"
    };
  }

  importMemory(path: string): MemoryImportInfo {
    let source: DatabaseSync | undefined;
    let submissions: JsonObject[] = [];
    let research: JsonObject[] = [];
    let rounds: JsonObject[] = [];
    let experiences: JsonObject[] = [];
    try {
      source = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 3_000 });
      const format = source.prepare("SELECT value FROM memory_meta WHERE key = 'format'").get();
      if (!isRecord(format) || format.value !== "xpuoj-memory/sqlite-v1") {
        throw new Error("unsupported memory export; expected xpuoj-memory/sqlite-v1");
      }
      submissions = source.prepare("SELECT * FROM submission_memory").all().filter(isRecord);
      research = source.prepare("SELECT * FROM research_memory").all().filter(isRecord);
      rounds = source.prepare("SELECT * FROM optimization_rounds").all().filter(isRecord);
      experiences = source.prepare("SELECT * FROM experience_memory").all().filter(isRecord);
    } catch (error) {
      throw new Error(`could not read XPUOJ SQLite memory export: ${error instanceof Error ? error.message : "invalid file"}`);
    } finally {
      source?.close();
    }
    const importSubmission = this.database.prepare(`
      INSERT INTO submission_memory (
        submission_id, target_key, language, source_code, code_sha256, status, score, display_score,
        time_used, memory_used, progress_type, compile_success, compile_message, diagnostics,
        submitted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(submission_id) DO UPDATE SET
        target_key = COALESCE(excluded.target_key, submission_memory.target_key),
        language = COALESCE(excluded.language, submission_memory.language),
        source_code = COALESCE(excluded.source_code, submission_memory.source_code),
        code_sha256 = COALESCE(excluded.code_sha256, submission_memory.code_sha256),
        status = COALESCE(excluded.status, submission_memory.status),
        score = COALESCE(excluded.score, submission_memory.score),
        display_score = COALESCE(excluded.display_score, submission_memory.display_score),
        time_used = COALESCE(excluded.time_used, submission_memory.time_used),
        memory_used = COALESCE(excluded.memory_used, submission_memory.memory_used),
        progress_type = COALESCE(excluded.progress_type, submission_memory.progress_type),
        compile_success = COALESCE(excluded.compile_success, submission_memory.compile_success),
        compile_message = COALESCE(excluded.compile_message, submission_memory.compile_message),
        diagnostics = COALESCE(excluded.diagnostics, submission_memory.diagnostics),
        submitted_at = COALESCE(excluded.submitted_at, submission_memory.submitted_at),
        updated_at = MAX(excluded.updated_at, submission_memory.updated_at)
    `);
    const findResearch = this.database.prepare(`
      SELECT id FROM research_memory
      WHERE kind = ? AND title = ? AND summary = ?
        AND COALESCE(hardware, '') = ? AND COALESCE(source_url, '') = ?
      LIMIT 1
    `);
    const importResearch = this.database.prepare(`
      INSERT INTO research_memory (kind, title, summary, hardware, source_url, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const importRound = this.database.prepare(`
      INSERT OR IGNORE INTO optimization_rounds (
        target_key, hypothesis, change_summary, evidence_ids, submission_id, outcome,
        display_score, decision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const findExperience = this.database.prepare(`
      SELECT id FROM experience_memory
      WHERE COALESCE(target_key, '') = ? AND COALESCE(hardware, '') = ? AND claim = ?
      LIMIT 1
    `);
    const importExperience = this.database.prepare(`
      INSERT INTO experience_memory (
        target_key, hardware, claim, confidence, evidence_round_ids, supersedes_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const researchIds = new Map<number, number>();
    let importedSubmissions = 0;
    let importedResearch = 0;
    let importedRounds = 0;
    let importedExperiences = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of submissions) {
        const id = asNullableNumber(row.submission_id);
        if (id === null) continue;
        importSubmission.run(
          id,
          asNullableString(row.target_key),
          asNullableString(row.language),
          asNullableString(row.source_code),
          asNullableString(row.code_sha256),
          asNullableString(row.status),
          asNullableNumber(row.score),
          asNullableNumber(row.display_score),
          asNullableNumber(row.time_used),
          asNullableNumber(row.memory_used),
          asNullableString(row.progress_type),
          asNullableNumber(row.compile_success),
          asNullableString(row.compile_message),
          asNullableString(row.diagnostics),
          asNullableString(row.submitted_at),
          asNullableNumber(row.updated_at) ?? Date.now()
        );
        importedSubmissions += 1;
      }
      for (const row of research) {
        const kind = asNullableString(row.kind);
        const title = asNullableString(row.title);
        const summary = asNullableString(row.summary);
        if (!kind || !validResearchKind(kind) || !title || !summary) continue;
        const hardware = asNullableString(row.hardware) ?? "";
        const sourceUrl = asNullableString(row.source_url) ?? "";
        const existing = findResearch.get(kind, title, summary, hardware, sourceUrl);
        const oldId = asNullableNumber(row.id);
        if (existing && isRecord(existing)) {
          const existingId = asNullableNumber(existing.id);
          if (oldId !== null && existingId !== null) researchIds.set(oldId, existingId);
          continue;
        }
        const result = importResearch.run(
          kind,
          title,
          summary,
          hardware || null,
          sourceUrl || null,
          asNullableString(row.tags) ?? "",
          asNullableNumber(row.created_at) ?? Date.now(),
          asNullableNumber(row.updated_at) ?? Date.now()
        );
        const newId = Number(result.lastInsertRowid);
        if (oldId !== null && Number.isSafeInteger(newId)) researchIds.set(oldId, newId);
        importedResearch += 1;
      }
      for (const row of rounds) {
        const target = asNullableString(row.target_key);
        const hypothesis = asNullableString(row.hypothesis);
        const changeSummary = asNullableString(row.change_summary);
        if (!target || !hypothesis || !changeSummary) continue;
        const evidence = idsFromString(asNullableString(row.evidence_ids)).map((id) => researchIds.get(id) ?? id);
        const result = importRound.run(
          target,
          hypothesis,
          changeSummary,
          [...new Set(evidence)].join(","),
          asNullableNumber(row.submission_id),
          asNullableString(row.outcome),
          asNullableNumber(row.display_score),
          asNullableString(row.decision) ?? "pending",
          asNullableNumber(row.created_at) ?? Date.now(),
          asNullableNumber(row.updated_at) ?? Date.now()
        );
        if (result.changes === 1) importedRounds += 1;
      }
      for (const row of experiences) {
        const claim = asNullableString(row.claim);
        if (!claim) continue;
        const target = asNullableString(row.target_key) ?? "";
        const hardware = asNullableString(row.hardware) ?? "";
        if (findExperience.get(target, hardware, claim)) continue;
        importExperience.run(
          target || null,
          hardware || null,
          claim,
          asNullableNumber(row.confidence) ?? 0,
          asNullableString(row.evidence_round_ids) ?? "",
          asNullableNumber(row.supersedes_id),
          asNullableString(row.state) === "superseded" ? "superseded" : "active",
          asNullableNumber(row.created_at) ?? Date.now(),
          asNullableNumber(row.updated_at) ?? Date.now()
        );
        importedExperiences += 1;
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { submissions: importedSubmissions, research: importedResearch, rounds: importedRounds, experiences: importedExperiences };
  }

  close(): void {
    if (this.database.isOpen) {
      this.database.close();
    }
  }
}

class UnavailableMemoryStore implements LocalMemoryStore {
  private readonly reason: string;

  constructor(error: unknown) {
    this.reason = error instanceof Error ? error.message : "local SQLite memory is unavailable";
  }

  recordSubmitted(): void {}

  recordSubmissionDetail(): void {}

  recordSubmissionList(): void {}

  planOptimizationRound(): OptimizationRoundRecord {
    throw new Error(`Local memory is unavailable: ${this.reason}`);
  }

  linkSubmissionToRound(): void {
    throw new Error(`Local memory is unavailable: ${this.reason}`);
  }

  getOptimizationMemory(target?: ProblemTarget): OptimizationMemory {
    return { target: target ? targetKey(target) : null, attempts: 0, finished: 0, accepted: 0, best: null, recent: [], rounds: [] };
  }

  rememberReference(): ResearchMemoryRecord {
    throw new Error(`Local memory is unavailable: ${this.reason}`);
  }

  searchReferences(): ResearchMemoryRecord[] {
    return [];
  }

  recallForOptimization(input: { target?: ProblemTarget }): OptimizationRecall {
    return { attempts: this.getOptimizationMemory(input.target), research: [], experiences: [] };
  }

  distillExperience(): ExperienceRecord {
    throw new Error(`Local memory is unavailable: ${this.reason}`);
  }

  exportMemory(): MemoryExportInfo {
    throw new Error(`Local memory is unavailable: ${this.reason}`);
  }

  importMemory(): MemoryImportInfo {
    throw new Error(`Local memory is unavailable: ${this.reason}`);
  }

  close(): void {}
}

export function openMemoryStore(path?: string): LocalMemoryStore {
  try {
    return new SqliteMemoryStore(path);
  } catch (error) {
    return new UnavailableMemoryStore(error);
  }
}
