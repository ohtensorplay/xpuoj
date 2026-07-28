#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { DEFAULT_SITE_URL } from "./browser.js";
import {
  describeTarget,
  discoverApiBase,
  getContestRanking,
  isRecord,
  resolveContestId,
  resolveProblemTarget,
  safeError,
  sha256Hex,
  summarizeProblem,
  summarizeSubmission,
  waitForSubmission,
  XpuojClient,
  XpuojError,
  type ContestRankingSummary,
  type JsonObject,
  type ProblemTarget,
  type SubmissionSummary
} from "./core.js";
import { runLocalMcp } from "./mcp.js";

const VERSION = "0.2.0";

const cliOptions = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  site: { type: "string" },
  "api-base": { type: "string" },
  locale: { type: "string" },
  "http-timeout": { type: "string" },
  "problem-id": { type: "string" },
  "contest-id": { type: "string" },
  "problem-order": { type: "string" },
  summary: { type: "boolean" },
  output: { type: "string", short: "o" },
  code: { type: "string", short: "c" },
  language: { type: "string", short: "l" },
  "options-json": { type: "string" },
  yes: { type: "boolean" },
  wait: { type: "boolean" },
  interval: { type: "string" },
  "poll-timeout": { type: "string" },
  "submission-id": { type: "string" },
  top: { type: "string" },
  json: { type: "boolean" },
  "full-json": { type: "boolean" },
  "relay-port": { type: "string" },
  "connect-timeout": { type: "string" },
  "no-open": { type: "boolean" }
} as const;

type ParsedValues = ReturnType<typeof parseCli>["values"];

function parseCli(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: cliOptions
  });
}

function help(): string {
  return `xpuoj ${VERSION}

Usage:
  xpuoj mcp [--relay-port 7423] [--no-open]
  xpuoj problem <URL|DISPLAY_ID> [--summary|--output FILE]
  xpuoj problem --contest-id ID --problem-order ORDER [--summary]
  xpuoj rank <CONTEST_URL|ID> [--top N|--json]
  xpuoj submit <URL|DISPLAY_ID> --code FILE --language LANGUAGE --yes [--wait]
  xpuoj status <SUBMISSION_ID> [--json|--full-json]
  xpuoj wait <SUBMISSION_ID> [--poll-timeout SECONDS]

Target alternatives:
  --problem-id ID
  --contest-id ID --problem-order ORDER

Authentication:
  The MCP bridge uses the Agent Relay built into the official XPUOJ website.
  In any browser, press Ctrl+B and connect to http://127.0.0.1:7423.
  No browser extension or cloud service is used. Direct API commands require
  XPUOJ_TOKEN in the environment; the MCP bridge never needs that variable.
`;
}

function integerOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new XpuojError("INVALID_ARGUMENT", `${label} must be a positive integer`);
  }
  return parsed;
}

function positiveNumber(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new XpuojError("INVALID_ARGUMENT", `${label} must be positive`);
  }
  return parsed;
}

function targetFromCli(
  values: ParsedValues,
  positional: string | undefined
): ProblemTarget {
  return resolveProblemTarget({
    target: positional,
    problemId: integerOption(values["problem-id"], "problem ID"),
    contestId: integerOption(values["contest-id"], "contest ID"),
    problemOrder: integerOption(values["problem-order"], "problem order")
  });
}

async function createClient(values: ParsedValues): Promise<{
  client: XpuojClient;
}> {
  const token = process.env.XPUOJ_TOKEN?.trim();
  if (!token) {
    throw new XpuojError(
      "AUTH_REQUIRED",
      "Direct API commands require XPUOJ_TOKEN. For browser-based use, run `xpuoj mcp`."
    );
  }
  const timeoutMs = positiveNumber(
    values["http-timeout"],
    30,
    "HTTP timeout"
  ) * 1_000;
  const apiBase =
    values["api-base"] ??
    process.env.XPUOJ_API_BASE ??
    (await discoverApiBase(values.site, fetch, timeoutMs));
  return {
    client: new XpuojClient({
      apiBase,
      token,
      timeoutMs
    })
  };
}

function parseOptionsJson(value: string | undefined): JsonObject {
  if (value === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new XpuojError("INVALID_ARGUMENT", "options JSON is invalid", { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new XpuojError("INVALID_ARGUMENT", "options JSON must be an object");
  }
  return parsed;
}

function submissionIdFromCli(
  values: ParsedValues,
  positional: string | undefined
): number {
  const raw = values["submission-id"] ?? positional;
  return integerOption(raw, "submission ID") ?? 0;
}

function contestIdFromCli(
  values: ParsedValues,
  positional: string | undefined
): number {
  return resolveContestId({
    target: positional,
    contestId: integerOption(values["contest-id"], "contest ID")
  });
}

function printProblemSummary(summary: JsonObject): void {
  console.log(`TITLE=${String(summary.title ?? "")}`);
  console.log(
    `ORDER=${String(summary.order ?? "")} TYPE=${String(summary.type ?? "")} SUBMITTABLE=${String(summary.submittable ?? "")}`
  );
  console.log(
    `LOCALE=${String(summary.locale ?? "")} LANGUAGES=${JSON.stringify(summary.languages ?? [])}`
  );
  console.log(
    `TIME_LIMIT=${String(summary.timeLimit ?? "")} MEMORY_LIMIT=${String(summary.memoryLimit ?? "")}`
  );
  console.log(`SECTIONS=${JSON.stringify(summary.sections ?? [])}`);
  console.log(`SAMPLES=${String(summary.sampleCount ?? 0)}`);
}

function printSubmission(summary: SubmissionSummary, diagnostics = true): void {
  console.log(
    `SUBMISSION=${String(summary.submissionId ?? "")} STATUS=${String(summary.status ?? "")} ` +
      `PROGRESS=${String(summary.progressType ?? "")} SCORE=${String(summary.score ?? "")} ` +
      `DISPLAY_SCORE=${String(summary.displayScore ?? "")} TIME=${String(summary.timeUsed ?? "")} ` +
      `MEMORY=${String(summary.memoryUsed ?? "")}`
  );
  if (summary.compile.success !== undefined) {
    console.log(`COMPILE_SUCCESS=${String(summary.compile.success)}`);
  }
  if (diagnostics && summary.compile.message) {
    console.log(
      `COMPILE_MESSAGE=${String(summary.compile.message).slice(0, 2_000).replaceAll("\n", " | ")}`
    );
  }
  for (const testcase of summary.testcases) {
    console.log(
      `TESTCASE=${testcase.hash.slice(0, 12)} STATUS=${String(testcase.status ?? "")} ` +
        `TIME=${String(testcase.time ?? "")} MEMORY=${String(testcase.memory ?? "")}`
    );
    if (diagnostics && testcase.checkerMessage) {
      console.log(
        `CHECKER=${String(testcase.checkerMessage).slice(0, 2_000).replaceAll("\n", " | ")}`
      );
    }
    if (diagnostics && testcase.userError) {
      console.log(
        `USER_ERROR=${String(testcase.userError).slice(0, 4_000).replaceAll("\n", " | ")}`
      );
    }
  }
}

function formatScore(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function printRanking(summary: ContestRankingSummary): void {
  console.log(
    `CONTEST=${summary.contestId} RANKED=${summary.total === null ? "unknown" : summary.total}`
  );
  if (summary.me) {
    console.log(
      `YOU=#${summary.me.rank} SCORE=${formatScore(summary.me.score)} USER=${summary.me.user}`
    );
  } else if (summary.participated === false) {
    console.log("YOU=not-ranked");
  } else {
    console.log("YOU=unavailable");
  }
  if (!summary.leaderboardAvailable) {
    console.log("TOP=unavailable");
    return;
  }
  console.log("TOP:");
  for (const entry of summary.leaders) {
    console.log(
      `#${entry.rank} SCORE=${formatScore(entry.score)} USER=${entry.user}`
    );
  }
}

async function commandProblem(
  values: ParsedValues,
  positional: string | undefined
): Promise<number> {
  const target = targetFromCli(values, positional);
  const { client } = await createClient(values);
  const problem = await client.getProblem(target, values.locale);
  const rendered = `${JSON.stringify(problem, undefined, 2)}\n`;
  if (values.output) {
    await writeFile(values.output, rendered, "utf8");
    console.log(`PROBLEM_SAVED=${values.output}`);
  }
  if (values.summary) {
    console.log(`SCOPE=${describeTarget(target)}`);
    printProblemSummary(summarizeProblem(problem));
  } else if (!values.output) {
    process.stdout.write(rendered);
  }
  return 0;
}

async function commandRank(
  values: ParsedValues,
  positional: string | undefined
): Promise<number> {
  const contestId = contestIdFromCli(values, positional);
  const top = integerOption(values.top, "top count") ?? 10;
  if (top > 50) {
    throw new XpuojError("INVALID_ARGUMENT", "top count cannot exceed 50");
  }
  const { client } = await createClient(values);
  const summary = await getContestRanking(client, contestId, top);
  if (values.json) {
    console.log(JSON.stringify(summary, undefined, 2));
  } else {
    printRanking(summary);
  }
  return 0;
}

async function commandSubmit(
  values: ParsedValues,
  positional: string | undefined
): Promise<number> {
  if (!values.yes) {
    throw new XpuojError(
      "INVALID_ARGUMENT",
      "submission blocked: pass --yes only after explicit user authorization"
    );
  }
  if (!values.code) {
    throw new XpuojError("INVALID_ARGUMENT", "--code is required");
  }
  const target = targetFromCli(values, positional);
  const language = values.language ?? "tilelang.maca-c500";
  let code: string;
  try {
    code = await readFile(values.code, "utf8");
  } catch (error) {
    throw new XpuojError(
      "INVALID_ARGUMENT",
      `Could not read source file: ${values.code}`,
      { cause: error }
    );
  }
  if (!code.trim()) {
    throw new XpuojError("INVALID_ARGUMENT", `refusing to submit empty source: ${values.code}`);
  }
  const digest = await sha256Hex(code);
  const { client } = await createClient(values);
  const result = await client.submitSolution(
    target,
    {
      code,
      language,
      compileAndRunOptions: parseOptionsJson(values["options-json"])
    },
    values.locale
  );
  console.log(
    `SUBMITTED=${result.submissionId} SCOPE=${describeTarget(target)} ` +
      `CODE_SHA256=${digest} LANGUAGE=${language} SOURCE=${values.code}`
  );
  if (!values.wait) {
    return 0;
  }
  const summary = await pollSubmission(client, result.submissionId, values);
  return summary.status === "Accepted" ? 0 : 1;
}

async function pollSubmission(
  client: XpuojClient,
  submissionId: number,
  values: ParsedValues
): Promise<SubmissionSummary> {
  let lastState = "";
  const summary = await waitForSubmission(client, submissionId, {
    locale: values.locale,
    intervalMs: positiveNumber(values.interval, 5, "poll interval") * 1_000,
    timeoutMs:
      positiveNumber(values["poll-timeout"], 600, "poll timeout") * 1_000,
    onUpdate(update) {
      const state = JSON.stringify([
        update.status,
        update.progressType,
        update.score,
        update.timeUsed,
        update.memoryUsed
      ]);
      if (state !== lastState) {
        printSubmission(update, false);
        lastState = state;
      }
    }
  });
  printSubmission(summary, true);
  return summary;
}

async function commandStatus(
  values: ParsedValues,
  positional: string | undefined
): Promise<number> {
  const submissionId = submissionIdFromCli(values, positional);
  const { client } = await createClient(values);
  const detail = await client.getSubmissionDetail(submissionId, values.locale);
  if (values["full-json"]) {
    console.log(JSON.stringify(detail, undefined, 2));
    return 0;
  }
  const summary = summarizeSubmission(detail);
  if (values.json) {
    console.log(JSON.stringify(summary, undefined, 2));
  } else {
    printSubmission(summary, true);
  }
  return 0;
}

async function commandWait(
  values: ParsedValues,
  positional: string | undefined
): Promise<number> {
  const submissionId = submissionIdFromCli(values, positional);
  const { client } = await createClient(values);
  const summary = await pollSubmission(client, submissionId, values);
  return summary.status === "Accepted" ? 0 : 1;
}

async function commandMcp(values: ParsedValues): Promise<number> {
  const relayPort = integerOption(values["relay-port"], "relay port") ?? 7423;
  if (relayPort > 65_535) {
    throw new XpuojError(
      "INVALID_ARGUMENT",
      "relay port cannot exceed 65535"
    );
  }
  await runLocalMcp({
    siteUrl: values.site ?? DEFAULT_SITE_URL,
    relayPort,
    connectTimeoutMs:
      positiveNumber(
        values["connect-timeout"],
        45,
        "browser connection timeout"
      ) * 1_000,
    openBrowser: values["no-open"] !== true
  });
  return 0;
}

async function main(): Promise<number> {
  const parsed = parseCli(process.argv.slice(2));
  if (parsed.values.version) {
    console.log(VERSION);
    return 0;
  }
  const command = parsed.positionals[0];
  if (parsed.values.help || command === undefined) {
    console.log(help());
    return command === undefined && !parsed.values.help ? 2 : 0;
  }
  const positional = parsed.positionals[1];
  switch (command) {
    case "problem":
      return commandProblem(parsed.values, positional);
    case "rank":
      return commandRank(parsed.values, positional);
    case "submit":
      return commandSubmit(parsed.values, positional);
    case "status":
      return commandStatus(parsed.values, positional);
    case "wait":
      return commandWait(parsed.values, positional);
    case "mcp":
      return commandMcp(parsed.values);
    default:
      throw new XpuojError("INVALID_ARGUMENT", `unknown command: ${command}`);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  const safe = safeError(error);
  console.error(`ERROR ${safe.code}: ${safe.message}`);
  process.exitCode = 2;
}
