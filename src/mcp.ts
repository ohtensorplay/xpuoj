import { createInterface } from "node:readline";

import { resolveToken, type ResolvedToken } from "./browser-auth.js";
import {
  discoverApiBase,
  isRecord,
  resolveContestId,
  resolveProblemTarget,
  safeError,
  sha256Hex,
  summarizeSubmission,
  summarizeContestRanking,
  XpuojClient,
  XpuojError,
  type JsonObject,
  type ProblemTarget,
  type SubmissionContent
} from "./core.js";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
}

interface DirectClient {
  getProblem(target: ProblemTarget, locale?: string): Promise<JsonObject>;
  getSubmissionDetail(submissionId: number, locale?: string): Promise<JsonObject>;
  submitSolution(
    target: ProblemTarget,
    content: SubmissionContent,
    locale?: string
  ): Promise<{ submissionId: number; target: ProblemTarget }>;
  getContestScoreboard(
    contestId: number,
    takeCount?: number,
    skipCount?: number
  ): Promise<JsonObject>;
  getContestScoreboardMe(contestId: number): Promise<JsonObject>;
}

export interface DirectMcpBridgeOptions {
  send: (message: unknown) => void;
  createClient?: () => Promise<{ client: DirectClient; auth: ResolvedToken }>;
}

const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {} };

const DIRECT_TOOLS: readonly McpTool[] = [
  {
    name: "xpuoj_connection_status",
    description:
      "Verify the current local Firefox, Chrome, Chromium, Edge, Brave, or Safari XPUOJ sign-in without opening a browser page.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "xpuoj_get_problem",
    description:
      "Fetch a complete XPUOJ ordinary or contest problem directly with the local browser sign-in. No browser tab navigation is required.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "An XPUOJ URL or ordinary display ID." },
        problemId: { type: "number", description: "Ordinary problem display ID." },
        contestId: { type: "number" },
        problemOrder: { type: "number" },
        locale: { type: "string", description: "Defaults to zh_CN." }
      }
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "xpuoj_get_ranking",
    description: "Fetch a contest leaderboard and the signed-in user's rank directly.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "A contest URL or contest ID." },
        contestId: { type: "number" },
        takeCount: { type: "number", minimum: 1, maximum: 50 }
      }
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "xpuoj_get_submission",
    description: "Fetch the official status, score, diagnostics, and optional full detail for a visible submission.",
    inputSchema: {
      type: "object",
      properties: {
        submissionId: { type: "number" },
        locale: { type: "string" },
        full: { type: "boolean", description: "Return full response instead of a safe summary." }
      },
      required: ["submissionId"]
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "xpuoj_submit_solution",
    description:
      "Submit exact source directly to XPUOJ. This is a non-idempotent external write and requires its SHA-256 plus explicit confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        problemId: { type: "number" },
        contestId: { type: "number" },
        problemOrder: { type: "number" },
        code: { type: "string" },
        language: { type: "string" },
        expectedSha256: { type: "string" },
        confirmExternalWrite: { type: "boolean" },
        locale: { type: "string" },
        compileAndRunOptions: { type: "object" }
      },
      required: ["code", "language", "expectedSha256", "confirmExternalWrite"]
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  }
];

function textToolResult(text: string, isError = false): unknown {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function rpcResult(id: JsonRpcId, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function asId(value: unknown): JsonRpcId | undefined {
  return typeof value === "string" || typeof value === "number" || value === null
    ? value
    : undefined;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new XpuojError("INVALID_ARGUMENT", `${label} must be a positive integer`);
  }
  return parsed;
}

function stringArgument(args: JsonObject, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectArgument(args: JsonObject, name: string): JsonObject {
  const value = args[name];
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new XpuojError("INVALID_ARGUMENT", `${name} must be an object`);
  }
  return value;
}

async function defaultClient(): Promise<{ client: DirectClient; auth: ResolvedToken }> {
  const auth = await resolveToken();
  const apiBase = await discoverApiBase();
  return { client: new XpuojClient({ apiBase, token: auth.token }), auth };
}

export class DirectMcpBridge {
  private readonly send: (message: unknown) => void;
  private readonly createClient: () => Promise<{ client: DirectClient; auth: ResolvedToken }>;

  constructor(options: DirectMcpBridgeOptions) {
    this.send = options.send;
    this.createClient = options.createClient ?? defaultClient;
  }

  async handle(message: unknown): Promise<void> {
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      this.send(rpcError(null, -32600, "Invalid Request"));
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const id = hasId ? asId(message.id) : undefined;
    if (typeof message.method !== "string") {
      this.send(rpcError(null, -32600, "Invalid Request"));
      return;
    }
    if (!hasId) {
      return;
    }
    if (id === undefined) {
      this.send(rpcError(null, -32600, "Invalid Request"));
      return;
    }
    try {
      switch (message.method) {
        case "initialize": {
          const params = isRecord(message.params) ? message.params : {};
          const protocolVersion =
            typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
          this.send(
            rpcResult(id, {
              protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "xpuoj-local-api", version: "0.3.0" },
              instructions:
                "XPUOJ reads the active local browser sign-in and calls the official API directly. No browser extension, page bridge, or Connect action is required."
            })
          );
          return;
        }
        case "ping":
          this.send(rpcResult(id, {}));
          return;
        case "tools/list":
          this.send(rpcResult(id, { tools: DIRECT_TOOLS }));
          return;
        case "tools/call":
          this.send(rpcResult(id, await this.callTool(message.params)));
          return;
        default:
          this.send(rpcError(id, -32601, `Method not found: ${message.method}`));
      }
    } catch (error) {
      const safe = safeError(error);
      this.send(rpcResult(id, textToolResult(`${safe.code}: ${safe.message}`, true)));
    }
  }

  private async callTool(params: unknown): Promise<unknown> {
    if (!isRecord(params) || typeof params.name !== "string") {
      return textToolResult("Missing MCP tool name.", true);
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (params.name === "xpuoj_connection_status") {
      const { client, auth } = await this.createClient();
      await client.getProblem({ kind: "ordinary", displayId: 1 });
      return textToolResult(JSON.stringify({ connected: true, source: auth.source }, undefined, 2));
    }
    if (params.name === "xpuoj_get_problem") {
      const { client } = await this.createClient();
      const target = resolveProblemTarget({
        target: stringArgument(args, "target"),
        problemId: args.problemId as number | undefined,
        contestId: args.contestId as number | undefined,
        problemOrder: args.problemOrder as number | undefined
      });
      const problem = await client.getProblem(target, stringArgument(args, "locale"));
      return textToolResult(JSON.stringify(problem, undefined, 2));
    }
    if (params.name === "xpuoj_get_ranking") {
      const { client } = await this.createClient();
      const contestId = resolveContestId({
        target: stringArgument(args, "target"),
        contestId: args.contestId as number | undefined
      });
      const takeCount = args.takeCount === undefined ? 10 : positiveInteger(args.takeCount, "takeCount");
      const [leaderboard, mine] = await Promise.allSettled([
        client.getContestScoreboard(contestId, takeCount),
        client.getContestScoreboardMe(contestId)
      ]);
      if (leaderboard.status === "rejected" && mine.status === "rejected") {
        throw mine.reason;
      }
      const ranking = summarizeContestRanking(
        contestId,
        leaderboard.status === "fulfilled" ? leaderboard.value : null,
        mine.status === "fulfilled" ? mine.value : null
      );
      return textToolResult(JSON.stringify(ranking, undefined, 2));
    }
    if (params.name === "xpuoj_get_submission") {
      const { client } = await this.createClient();
      const detail = await client.getSubmissionDetail(
        positiveInteger(args.submissionId, "submissionId"),
        stringArgument(args, "locale")
      );
      return textToolResult(
        JSON.stringify(args.full === true ? detail : summarizeSubmission(detail), undefined, 2)
      );
    }
    if (params.name === "xpuoj_submit_solution") {
      if (args.confirmExternalWrite !== true) {
        return textToolResult("Submission requires confirmExternalWrite=true.", true);
      }
      const code = stringArgument(args, "code");
      const expectedSha256 = stringArgument(args, "expectedSha256");
      const language = stringArgument(args, "language");
      if (!code || !expectedSha256 || !language) {
        return textToolResult("code, language, and expectedSha256 are required.", true);
      }
      const actualSha256 = await sha256Hex(code);
      if (actualSha256 !== expectedSha256) {
        return textToolResult("SOURCE_HASH_MISMATCH: code does not match expectedSha256.", true);
      }
      const { client } = await this.createClient();
      const target = resolveProblemTarget({
        target: stringArgument(args, "target"),
        problemId: args.problemId as number | undefined,
        contestId: args.contestId as number | undefined,
        problemOrder: args.problemOrder as number | undefined
      });
      const result = await client.submitSolution(
        target,
        {
          code,
          language,
          compileAndRunOptions: objectArgument(args, "compileAndRunOptions")
        },
        stringArgument(args, "locale")
      );
      return textToolResult(
        JSON.stringify(
          { submissionId: result.submissionId, target: result.target, sha256: actualSha256 },
          undefined,
          2
        )
      );
    }
    return textToolResult(`Unknown XPUOJ tool: ${params.name}`, true);
  }
}

export async function runLocalMcp(): Promise<void> {
  const pending = new Set<Promise<void>>();
  const bridge = new DirectMcpBridge({
    send(message) {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    }
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  lines.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch {
      process.stdout.write(`${JSON.stringify(rpcError(null, -32700, "Parse error"))}\n`);
      return;
    }
    const task = bridge.handle(message).finally(() => pending.delete(task));
    pending.add(task);
  });
  await new Promise<void>((resolve) => lines.once("close", resolve));
  await Promise.allSettled(pending);
}
