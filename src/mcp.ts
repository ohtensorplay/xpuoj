import { createInterface } from "node:readline";

import { resolveToken, type ResolvedToken } from "./browser-auth.js";
import {
  openMemoryStore,
  type LocalMemoryStore,
  type OptimizationRecall,
  type ResearchKind,
  type ResearchMemoryRecord
} from "./history.js";
import {
  discoverApiBase,
  isRecord,
  resolveContestId,
  resolveProblemTarget,
  safeError,
  sha256Hex,
  summarizeProblem,
  summarizeSubmission,
  summarizeSubmissionList,
  summarizeContestRanking,
  XpuojClient,
  XpuojError,
  type JsonObject,
  type ProblemTarget,
  type SubmissionScope,
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
  getCurrentUsername(): Promise<string>;
  getSubmissionDetail(submissionId: number, locale?: string): Promise<JsonObject>;
  listSubmissions(
    target: SubmissionScope | undefined,
    options?: { locale?: string; takeCount?: number; maxId?: number; language?: string }
  ): Promise<{ username: string; response: JsonObject }>;
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
  history?: LocalMemoryStore;
}

const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {} };

const DIRECT_TOOLS: readonly McpTool[] = [
  {
    name: "connection_status",
    description:
      "Verify the current local Firefox, Chrome, Chromium, Edge, Brave, or Safari XPUOJ sign-in without opening a browser page.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "get_problem",
    description:
      "Read an XPUOJ ordinary or contest problem. Returns a compact brief by default; set includeStatement=true only when the full statement is needed.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "An XPUOJ URL or ordinary display ID." },
        problemId: { type: "number", description: "Ordinary problem display ID." },
        contestId: { type: "number" },
        problemOrder: { type: "number" },
        locale: { type: "string", description: "Defaults to zh_CN." },
        includeStatement: {
          type: "boolean",
          description: "Include the complete statement and samples. Defaults to false to conserve context."
        }
      }
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "get_ranking",
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
    name: "get_optimization_context",
    description:
      "Recall compact local optimization memory: prior candidates and verdicts plus relevant hardware or algorithm evidence. Call before changing a solution.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Optional XPUOJ problem URL or ordinary display ID." },
        problemId: { type: "number" },
        contestId: { type: "number" },
        problemOrder: { type: "number" },
        query: { type: "string", description: "Operator, algorithm, hardware, or failure-mechanism terms." },
        hardware: { type: "string", description: "Target accelerator or architecture, for example CUDA A800 or MACA C500." },
        tags: { type: "array", items: { type: "string" }, maxItems: 12 },
        takeCount: { type: "number", minimum: 1, maximum: 20, description: "Defaults to 8." }
      }
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "plan_optimization_round",
    description:
      "Create a local, evidence-linked optimization hypothesis before a candidate is submitted. Pass its roundId to submit_solution so the official verdict can automatically keep, mark equivalent, or revert the experiment.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "An XPUOJ problem URL or ordinary display ID." },
        problemId: { type: "number" },
        contestId: { type: "number" },
        problemOrder: { type: "number" },
        hypothesis: { type: "string", description: "Falsifiable bottleneck or performance hypothesis." },
        changeSummary: { type: "string", description: "One coherent code or schedule change to test." },
        evidenceIds: { type: "array", items: { type: "number" }, maxItems: 12, description: "Optional IDs returned by remember_research." }
      },
      required: ["hypothesis", "changeSummary"]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "distill_experience",
    description:
      "Promote one verified lesson from official terminal optimization rounds into versioned local experience memory. It can supersede an older conclusion when new evidence disproves it.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        problemId: { type: "number" },
        contestId: { type: "number" },
        problemOrder: { type: "number" },
        hardware: { type: "string" },
        claim: { type: "string", description: "Short, falsifiable, action-oriented conclusion." },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        evidenceRoundIds: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 12 },
        supersedesId: { type: "number", description: "Optional experience ID replaced by this evidence." }
      },
      required: ["claim", "confidence", "evidenceRoundIds"]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "remember_research",
    description:
      "Store a concise, source-attributed hardware, algorithm, benchmark, or local note for later optimization recall. This writes only to local SQLite memory.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["hardware", "algorithm", "benchmark", "note"] },
        title: { type: "string" },
        summary: { type: "string", description: "Concise actionable finding, not copied source text." },
        hardware: { type: "string", description: "Accelerator or architecture this finding applies to." },
        sourceUrl: { type: "string", description: "Primary source URL when available." },
        tags: { type: "array", items: { type: "string" }, maxItems: 12 }
      },
      required: ["kind", "title", "summary"]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "get_research_plan",
    description:
      "Produce a source-prioritized research plan for an operator and hardware target before an optimization round. It guides official documentation, papers, upstream code, and community evidence without fetching or storing anything.",
    inputSchema: {
      type: "object",
      properties: {
        operator: { type: "string", description: "Operator or kernel family, for example flash attention or GEMM." },
        hardware: { type: "string", description: "Target accelerator or architecture." },
        symptom: { type: "string", description: "Observed official bottleneck, regression, or correctness failure." }
      },
      required: ["operator", "hardware"]
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "search_research",
    description:
      "Search compact local hardware, algorithm, benchmark, and note memory. Returns only summaries and source links.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string", enum: ["hardware", "algorithm", "benchmark", "note"] },
        hardware: { type: "string", description: "Restrict to an accelerator or architecture." },
        takeCount: { type: "number", minimum: 1, maximum: 50, description: "Defaults to 10." }
      }
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "export_memory",
    description:
      "Create a portable self-contained xpuoj-memory SQLite snapshot for another CLI. The binary includes submission evidence, source, research, experiments, and distilled experience.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "import_memory",
    description:
      "Merge a portable xpuoj-memory SQLite snapshot into local memory without deleting existing records.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path to an xpuoj-memory SQLite snapshot." } },
      required: ["path"]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "list_submissions",
    description:
      "List the signed-in user's submission history, optionally scoped to one problem. Returns compact records; use maxId to request older records.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Optional XPUOJ problem URL, contest submissions URL, or ordinary display ID." },
        problemId: { type: "number", description: "Optional ordinary problem display ID." },
        contestId: { type: "number", description: "Optional contest ID. Without problemOrder, lists all contest problems." },
        problemOrder: { type: "number", description: "Optional contest problem order." },
        takeCount: { type: "number", minimum: 1, maximum: 50, description: "Defaults to 20." },
        maxId: { type: "number", description: "Request records older than this submission ID." },
        language: { type: "string", description: "Optional XPUOJ language filter." },
        locale: { type: "string", description: "Defaults to zh_CN." }
      }
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "get_submission",
    description: "Read a compact official verdict, score, and failure diagnostics for one visible submission.",
    inputSchema: {
      type: "object",
      properties: {
        submissionId: { type: "number" },
        locale: { type: "string", description: "Defaults to zh_CN." }
      },
      required: ["submissionId"]
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "get_submission_source",
    description:
      "Read the exact source code of one submission. This intentionally returns code, so call it only when the source is needed.",
    inputSchema: {
      type: "object",
      properties: {
        submissionId: { type: "number" },
        locale: { type: "string", description: "Defaults to zh_CN." }
      },
      required: ["submissionId"]
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "submit_solution",
    description:
      "Submit source directly to XPUOJ. The submitted code is hashed and the hash is returned. This non-idempotent external write requires explicit confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        problemId: { type: "number" },
        contestId: { type: "number" },
        problemOrder: { type: "number" },
        code: { type: "string" },
        language: { type: "string" },
        roundId: { type: "number", description: "Optional plan_optimization_round ID to bind to this official attempt." },
        confirmExternalWrite: { type: "boolean" },
        locale: { type: "string" },
        compileAndRunOptions: { type: "object" }
      },
      required: ["code", "language", "confirmExternalWrite"]
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
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

function stringArrayArgument(args: JsonObject, name: string): string[] {
  const raw = args[name];
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string")) {
    throw new XpuojError("INVALID_ARGUMENT", `${name} must be an array of strings`);
  }
  return [...new Set(raw.map((value) => value.trim()).filter(Boolean))].slice(0, 12);
}

function positiveIntegerArrayArgument(args: JsonObject, name: string): number[] {
  const raw = args[name];
  if (!Array.isArray(raw)) {
    throw new XpuojError("INVALID_ARGUMENT", `${name} must be an array of positive integers`);
  }
  return [...new Set(raw.map((value) => positiveInteger(value, name)))].slice(0, 12);
}

function researchKindArgument(args: JsonObject): ResearchKind {
  const kind = stringArgument(args, "kind");
  if (kind === "hardware" || kind === "algorithm" || kind === "benchmark" || kind === "note") {
    return kind;
  }
  throw new XpuojError("INVALID_ARGUMENT", "kind must be hardware, algorithm, benchmark, or note");
}

function targetArgument(args: JsonObject): ProblemTarget | undefined {
  const target = stringArgument(args, "target");
  const problemId = args.problemId as number | undefined;
  const contestId = args.contestId as number | undefined;
  const problemOrder = args.problemOrder as number | undefined;
  if (target === undefined && problemId === undefined && contestId === undefined && problemOrder === undefined) {
    return undefined;
  }
  return resolveProblemTarget({ target, problemId, contestId, problemOrder });
}

function submissionScopeArgument(args: JsonObject): SubmissionScope | undefined {
  const target = stringArgument(args, "target");
  const contestId = args.contestId as number | undefined;
  const problemOrder = args.problemOrder as number | undefined;
  const problemId = args.problemId as number | undefined;
  if (contestId !== undefined && problemOrder === undefined && target === undefined && problemId === undefined) {
    return { kind: "contest-all", contestId: resolveContestId({ contestId }) };
  }
  if (target !== undefined && contestId === undefined && problemOrder === undefined && problemId === undefined) {
    try {
      const url = new URL(target);
      if (/^\/(?:contest|c)\/\d+(?:\/submissions)?\/?$/.test(url.pathname)) {
        return { kind: "contest-all", contestId: resolveContestId({ target }) };
      }
    } catch {
      // Not a URL: let the regular problem resolver produce its user-facing error.
    }
  }
  return targetArgument(args);
}

function value(value: unknown, fallback = "—"): string {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  return String(value).replace(/\s+/g, " ").trim() || fallback;
}

function clipped(value: string, maximum = 280): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function shortHash(value: string | null): string {
  return value ? `${value.slice(0, 12)}…` : "—";
}

function formatResearch(records: ResearchMemoryRecord[], heading: string): string {
  const lines = [`# ${heading}（${records.length} 条）`];
  if (!records.length) {
    return [...lines, "没有匹配的本地研究记忆。"].join("\n");
  }
  for (const record of records) {
    lines.push(`## [${record.kind}] ${record.title}`);
    lines.push(clipped(record.summary));
    const metadata = [
      record.hardware ? `硬件：${record.hardware}` : "",
      record.tags.length ? `标签：${record.tags.join("、")}` : "",
      record.sourceUrl ? `来源：${record.sourceUrl}` : "来源：本地观察"
    ].filter(Boolean).join(" · ");
    lines.push(metadata);
  }
  return lines.join("\n");
}

function formatResearchPlan(operator: string, hardware: string, symptom?: string): string {
  return [
    `# 调研路线 · ${operator} · ${hardware}`,
    symptom ? `已知现象：${symptom}` : "先记录可复现的官方现象、分数或诊断。",
    "",
    "1. 官方硬件资料（最高优先级）",
    `- 搜索：${hardware} architecture programming guide、compiler/ISA reference、profiler metric guide、release notes。`,
    "- 记录：执行模型、线程/波前/warp、内存层次、同步语义、指令与编译器限制。",
    "",
    "2. 算法与上游实现",
    `- 搜索：${operator} paper、reference implementation、upstream benchmark、official library kernel。`,
    "- 记录：复杂度、分块/布局、数值约束、适用形状与已有反例。",
    "",
    "3. 社区证据（用于发现线索，不能单独定论）",
    `- 搜索：${hardware} ${operator} GitHub issues、vendor developer forum、可运行复现仓库。`,
    "- 将社区建议回链到源码、官方文档或官方判题结果，再通过 remember_research 入库。",
    "",
    "4. 实验闭环",
    "- get_optimization_context → remember_research → plan_optimization_round → submit_solution → get_submission → distill_experience。",
    "- 每轮只测试一个可证伪改动；XPUOJ 性能结论只接受官方终局结果。"
  ].join("\n");
}

function formatOptimizationContext(recall: OptimizationRecall): string {
  const memory = recall.attempts;
  const lines = [
    `# 优化记忆${memory.target ? ` · ${memory.target}` : ""}`,
    `候选：${memory.attempts} · 已结束：${memory.finished} · Accepted：${memory.accepted}`
  ];
  if (memory.best) {
    lines.push(`最佳：#${memory.best.submissionId} · 展示分 ${value(memory.best.displayScore)} · ${value(memory.best.status)} · ${shortHash(memory.best.codeSha256)}`);
  }
  if (memory.recent.length) {
    lines.push("", "近期候选：");
    lines.push(...memory.recent.slice(0, 5).map((record) =>
      `- #${record.submissionId} · ${value(record.status)} · 展示分 ${value(record.displayScore)} · ${value(record.language)} · ${shortHash(record.codeSha256)}`
    ));
  }
  if (recall.experiences.length) {
    lines.push("", "已提炼经验：");
    lines.push(...recall.experiences.slice(0, 5).map((experience) =>
      `- [${experience.state} · 置信度 ${experience.confidence.toFixed(2)}] ${experience.claim}${experience.hardware ? ` · ${experience.hardware}` : ""}（轮次 ${experience.evidenceRoundIds.join("、")}）`
    ));
  }
  if (memory.rounds.length) {
    lines.push("", "实验轨迹：");
    lines.push(...memory.rounds.slice(0, 5).map((round) =>
      `- R${round.id} · ${round.decision} · ${round.submissionId ? `#${round.submissionId}` : "未提交"} · ${clipped(round.hypothesis, 120)}`
    ));
  }
  if (recall.research.length) {
    lines.push("", "相关资料：");
    for (const candidate of recall.research) {
      const record = candidate.record;
      lines.push(`- [${record.kind}] ${record.title}（匹配：${candidate.matched.join("、") || "近期"}）`);
      lines.push(`  ${clipped(record.summary, 180)}${record.sourceUrl ? ` · ${record.sourceUrl}` : ""}`);
    }
  } else {
    lines.push("", "相关资料：无；可用 remember_research 保存有来源的硬件或算法结论。");
  }
  return lines.join("\n");
}

function formatProblem(problem: JsonObject, includeStatement: boolean): string {
  const summary = summarizeProblem(problem);
  const lines = [
    `# ${value(summary.title, "未命名题目")}`,
    `类型：${value(summary.type)} · 可提交：${summary.submittable === false ? "否" : "是"}`,
    `限制：时间 ${value(summary.timeLimit)} · 内存 ${value(summary.memoryLimit)}`,
    `语言：${Array.isArray(summary.languages) && summary.languages.length ? summary.languages.join("、") : "未声明"}`,
    `样例：${value(summary.sampleCount, "0")} 个 · 章节：${Array.isArray(summary.sections) ? summary.sections.join("、") || "未声明" : "未声明"}`
  ];
  if (!includeStatement) {
    lines.push("提示：需完整题面时，使用 includeStatement=true。");
    return lines.join("\n");
  }
  const localized = isRecord(problem.localizedContentsOfLocale)
    ? problem.localizedContentsOfLocale
    : {};
  const sections = Array.isArray(localized.contentSections) ? localized.contentSections : [];
  const statement = sections.filter(isRecord).flatMap((section) => {
    const heading = value(section.sectionTitle ?? section.type, "说明");
    const text = typeof section.text === "string" ? section.text.trim() : "";
    const codeSample = isRecord(section.codeSample) ? section.codeSample : {};
    const code = typeof codeSample.code === "string" ? codeSample.code.trim() : "";
    const language = typeof codeSample.language === "string" ? codeSample.language.trim() : "";
    return [
      `## ${heading}`,
      ...(text ? [text] : []),
      ...(code ? [`\`\`\`${language}\n${code}\n\`\`\``] : [])
    ];
  });
  const samples = Array.isArray(problem.samples) ? problem.samples.filter(isRecord) : [];
  for (const [index, sample] of samples.entries()) {
    const input = typeof sample.inputData === "string" ? sample.inputData.trim() : "";
    const output = typeof sample.outputData === "string" ? sample.outputData.trim() : "";
    statement.push(`## 样例 ${index + 1}`, `输入\n\`\`\`\n${input}\n\`\`\``, `输出\n\`\`\`\n${output}\n\`\`\``);
  }
  return [...lines, "", ...statement].join("\n");
}

function formatRanking(ranking: ReturnType<typeof summarizeContestRanking>): string {
  const lines = [`# 竞赛 ${ranking.contestId} 排行`, `总人数：${value(ranking.total)}`];
  if (ranking.me) {
    lines.push(`我的排名：#${ranking.me.rank} · 分数 ${ranking.me.score} · 罚时 ${value(ranking.me.penalty)}`);
  } else {
    lines.push(ranking.participated === false ? "我的状态：未参与" : "我的排名：暂不可用");
  }
  if (ranking.leaders.length) {
    lines.push("", "| 排名 | 用户 | 分数 | 罚时 |", "| ---: | --- | ---: | ---: |");
    lines.push(...ranking.leaders.map((entry) => `| ${entry.rank} | ${entry.user} | ${entry.score} | ${value(entry.penalty)} |`));
  }
  return lines.join("\n");
}

function formatSubmission(detail: JsonObject): string {
  const summary = summarizeSubmission(detail);
  const lines = [
    `# 提交 #${value(summary.submissionId)}`,
    `状态：${value(summary.status)} · 分数：${value(summary.score)} · 展示分：${value(summary.displayScore)}`,
    `耗时：${value(summary.timeUsed)} · 内存：${value(summary.memoryUsed)} · 阶段：${value(summary.progressType)}`,
    `编译：${summary.compile.success === true ? "通过" : summary.compile.success === false ? "失败" : "未知"}`
  ];
  if (summary.compile.message) {
    lines.push(`编译信息：${value(summary.compile.message)}`);
  }
  const failed = summary.testcases.filter((testcase) => testcase.status !== "Accepted");
  if (failed.length) {
    lines.push(`失败测试点：${failed.length}/${summary.testcases.length}`);
    lines.push(...failed.slice(0, 3).map((testcase, index) => `- #${index + 1}：${value(testcase.status)}${testcase.userError ? ` · ${value(testcase.userError)}` : testcase.checkerMessage ? ` · ${value(testcase.checkerMessage)}` : ""}`));
    if (failed.length > 3) lines.push(`- 其余 ${failed.length - 3} 个失败测试点已省略。`);
  } else if (summary.testcases.length) {
    lines.push(`测试点：${summary.testcases.length}/${summary.testcases.length} 通过`);
  }
  return lines.join("\n");
}

function formatSubmissionList(
  listed: Awaited<ReturnType<DirectClient["listSubmissions"]>>
): string {
  const summary = summarizeSubmissionList(listed.response, listed.username);
  const lines = [`# ${summary.username} 的提交记录（${summary.submissions.length} 条）`];
  if (summary.submissions.length) {
    lines.push("| ID | 题目 | 状态 | 展示分 | 语言 | 提交时间 |", "| ---: | --- | --- | ---: | --- | --- |");
    lines.push(...summary.submissions.map((submission) => {
      const problem = submission.problem.contestId
        ? `竞赛 ${value(submission.problem.contestId)} / 题目 ${value(submission.problem.order)}`
        : `/p/${value(submission.problem.displayId)}`;
      return `| ${value(submission.submissionId)} | ${problem} ${value(submission.problem.title)} | ${value(submission.status)} | ${value(submission.displayScore)} | ${value(submission.language)} | ${value(submission.submittedAt)} |`;
    }));
  } else {
    lines.push("没有符合条件的提交记录。");
  }
  if (summary.hasOlder === true) lines.push("还有更早记录：传入当前最小 ID 作为 maxId 继续查询。");
  return lines.join("\n");
}

async function formatSubmissionSource(detail: JsonObject): Promise<string> {
  const meta = isRecord(detail.meta) ? detail.meta : {};
  const content = isRecord(detail.content) ? detail.content : {};
  const code = typeof content.code === "string" ? content.code : "";
  const language = typeof content.language === "string" ? content.language : "text";
  if (!code) {
    throw new XpuojError("PERMISSION_DENIED", "This submission's source is not available to the signed-in user.");
  }
  return `# 提交 #${value(meta.id)} 源码\n语言：${language} · codeSha256：${await sha256Hex(code)}\n\n\`\`\`${language}\n${code}\n\`\`\``;
}

async function defaultClient(): Promise<{ client: DirectClient; auth: ResolvedToken }> {
  const auth = await resolveToken();
  const apiBase = await discoverApiBase();
  return { client: new XpuojClient({ apiBase, token: auth.token }), auth };
}

export class DirectMcpBridge {
  private readonly send: (message: unknown) => void;
  private readonly createClient: () => Promise<{ client: DirectClient; auth: ResolvedToken }>;
  private readonly history: LocalMemoryStore;

  constructor(options: DirectMcpBridgeOptions) {
    this.send = options.send;
    this.createClient = options.createClient ?? defaultClient;
    this.history = options.history ?? openMemoryStore();
  }

  close(): void {
    this.history.close();
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
              serverInfo: { name: "xpuoj-local-api", version: "0.4.0" },
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
    if (params.name === "connection_status") {
      const { client, auth } = await this.createClient();
      const username = await client.getCurrentUsername();
      return textToolResult(`已连接 XPUOJ · 账号：${username} · 浏览器：${auth.source}`);
    }
    if (params.name === "get_problem") {
      const { client } = await this.createClient();
      const target = resolveProblemTarget({
        target: stringArgument(args, "target"),
        problemId: args.problemId as number | undefined,
        contestId: args.contestId as number | undefined,
        problemOrder: args.problemOrder as number | undefined
      });
      const problem = await client.getProblem(target, stringArgument(args, "locale"));
      const memory = this.history.getOptimizationMemory(target, 1);
      const historyLine = memory.attempts
        ? `\n\n本地优化记忆：${memory.attempts} 个候选；最佳 ${memory.best ? `#${memory.best.submissionId}（展示分 ${value(memory.best.displayScore)}）` : "尚无评分"}。需要详情时调用 get_optimization_context。`
        : "";
      return textToolResult(`${formatProblem(problem, args.includeStatement === true)}${historyLine}`);
    }
    if (params.name === "get_ranking") {
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
      return textToolResult(formatRanking(ranking));
    }
    if (params.name === "get_optimization_context") {
      return textToolResult(formatOptimizationContext(this.history.recallForOptimization({
        target: targetArgument(args),
        query: stringArgument(args, "query"),
        hardware: stringArgument(args, "hardware"),
        tags: stringArrayArgument(args, "tags"),
        limit: args.takeCount === undefined ? undefined : positiveInteger(args.takeCount, "takeCount")
      })));
    }
    if (params.name === "plan_optimization_round") {
      const target = targetArgument(args);
      if (!target) throw new XpuojError("INVALID_ARGUMENT", "an XPUOJ target is required");
      const round = this.history.planOptimizationRound({
        target,
        hypothesis: stringArgument(args, "hypothesis") ?? "",
        changeSummary: stringArgument(args, "changeSummary") ?? "",
        evidenceIds: args.evidenceIds === undefined ? [] : positiveIntegerArrayArgument(args, "evidenceIds")
      });
      return textToolResult(`已创建实验 R${round.id} · ${round.target}\n假设：${round.hypothesis}\n改动：${round.changeSummary}`);
    }
    if (params.name === "distill_experience") {
      const experience = this.history.distillExperience({
        target: targetArgument(args),
        hardware: stringArgument(args, "hardware"),
        claim: stringArgument(args, "claim") ?? "",
        confidence: typeof args.confidence === "number" ? args.confidence : Number.NaN,
        evidenceRoundIds: positiveIntegerArrayArgument(args, "evidenceRoundIds"),
        supersedesId: args.supersedesId === undefined ? undefined : positiveInteger(args.supersedesId, "supersedesId")
      });
      return textToolResult(`已提炼经验 E${experience.id} · 置信度 ${experience.confidence.toFixed(2)}\n${experience.claim}`);
    }
    if (params.name === "remember_research") {
      const record = this.history.rememberReference({
        kind: researchKindArgument(args),
        title: stringArgument(args, "title") ?? "",
        summary: stringArgument(args, "summary") ?? "",
        hardware: stringArgument(args, "hardware"),
        sourceUrl: stringArgument(args, "sourceUrl"),
        tags: stringArrayArgument(args, "tags")
      });
      return textToolResult(`已写入本地研究记忆 #${record.id} · [${record.kind}] ${record.title}`);
    }
    if (params.name === "get_research_plan") {
      const operator = stringArgument(args, "operator");
      const hardware = stringArgument(args, "hardware");
      if (!operator || !hardware) {
        throw new XpuojError("INVALID_ARGUMENT", "operator and hardware are required");
      }
      return textToolResult(formatResearchPlan(operator, hardware, stringArgument(args, "symptom")));
    }
    if (params.name === "search_research") {
      const kind = args.kind === undefined ? undefined : researchKindArgument(args);
      return textToolResult(formatResearch(
        this.history.searchReferences(
          stringArgument(args, "query"),
          kind,
          stringArgument(args, "hardware"),
          args.takeCount === undefined ? undefined : positiveInteger(args.takeCount, "takeCount")
        ),
        "研究记忆"
      ));
    }
    if (params.name === "export_memory") {
      const exported = this.history.exportMemory();
      return textToolResult(`已导出 ${exported.format}\n路径：${exported.path}\nSHA-256：${exported.sha256}\n提交 ${exported.submissions} · 资料 ${exported.research} · 实验 ${exported.rounds} · 经验 ${exported.experiences}`);
    }
    if (params.name === "import_memory") {
      const path = stringArgument(args, "path");
      if (!path) throw new XpuojError("INVALID_ARGUMENT", "path is required");
      const imported = this.history.importMemory(path);
      return textToolResult(`已合并 SQLite 记忆：提交 ${imported.submissions} · 资料 ${imported.research} · 实验 ${imported.rounds} · 经验 ${imported.experiences}`);
    }
    if (params.name === "list_submissions") {
      const { client } = await this.createClient();
      const listed = await client.listSubmissions(submissionScopeArgument(args), {
        locale: stringArgument(args, "locale"),
        takeCount: args.takeCount === undefined ? undefined : positiveInteger(args.takeCount, "takeCount"),
        maxId: args.maxId === undefined ? undefined : positiveInteger(args.maxId, "maxId"),
        language: stringArgument(args, "language")
      });
      try {
        this.history.recordSubmissionList(listed.response);
      } catch {
        // Local memory must not interrupt a live XPUOJ read.
      }
      return textToolResult(formatSubmissionList(listed));
    }
    if (params.name === "get_submission") {
      const { client } = await this.createClient();
      const detail = await client.getSubmissionDetail(
        positiveInteger(args.submissionId, "submissionId"),
        stringArgument(args, "locale")
      );
      try {
        this.history.recordSubmissionDetail(detail);
      } catch {
        // Local memory must not interrupt a live XPUOJ read.
      }
      return textToolResult(formatSubmission(detail));
    }
    if (params.name === "get_submission_source") {
      const { client } = await this.createClient();
      const detail = await client.getSubmissionDetail(
        positiveInteger(args.submissionId, "submissionId"),
        stringArgument(args, "locale")
      );
      try {
        this.history.recordSubmissionDetail(detail);
      } catch {
        // Local memory must not interrupt a live XPUOJ read.
      }
      return textToolResult(await formatSubmissionSource(detail));
    }
    if (params.name === "submit_solution") {
      if (args.confirmExternalWrite !== true) {
        return textToolResult("Submission requires confirmExternalWrite=true.", true);
      }
      const code = stringArgument(args, "code");
      const language = stringArgument(args, "language");
      if (!code || !language) {
        return textToolResult("code and language are required.", true);
      }
      const actualSha256 = await sha256Hex(code);
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
      try {
        this.history.recordSubmitted({
          submissionId: result.submissionId,
          target: result.target,
          code,
          codeSha256: actualSha256,
          language
        });
        if (args.roundId !== undefined) {
          this.history.linkSubmissionToRound(
            positiveInteger(args.roundId, "roundId"),
            result.submissionId
          );
        }
      } catch {
        // The remote submission succeeded even if local persistence did not.
      }
      return textToolResult(
        `已提交 #${result.submissionId} · ${result.target.kind === "ordinary" ? `/p/${result.target.displayId}` : `竞赛 ${result.target.contestId} / 题目 ${result.target.problemOrder}`} · codeSha256：${actualSha256}`
      );
    }
    return textToolResult(`Unknown tool: ${params.name}`, true);
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
  bridge.close();
}
