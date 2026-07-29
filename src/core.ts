export const DEFAULT_SITE = "https://xpuoj.com";
export const DEFAULT_API_ROOT =
  "https://sd629vuj4f7uh2cscrbe0.apigateway-cn-beijing.volceapi.com";

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;

const TERMINAL_STATUSES = new Set([
  "Accepted",
  "WrongAnswer",
  "CompileError",
  "RuntimeError",
  "TimeLimitExceeded",
  "MemoryLimitExceeded",
  "OutputLimitExceeded",
  "JudgementFailed",
  "ConfigurationError",
  "SystemError",
  "Canceled"
]);

const AUTHENTICATION_ERRORS = new Set([
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
  "INVALID_TOKEN"
]);

export type JsonObject = Record<string, unknown>;

export type ProblemTarget =
  | {
      kind: "ordinary";
      displayId: number;
    }
  | {
      kind: "contest";
      contestId: number;
      problemOrder: number;
    };

export type SubmissionScope =
  | ProblemTarget
  | {
      kind: "contest-all";
      contestId: number;
    };

export interface ProblemTargetInput {
  target?: string;
  problemId?: number;
  contestId?: number;
  problemOrder?: number;
}

export interface ContestTargetInput {
  target?: string;
  contestId?: number;
}

export interface ContestRankEntry {
  rank: number;
  user: string;
  score: number;
  penalty: number | null;
}

export interface ContestRankingSummary {
  contestId: number;
  total: number | null;
  leaderboardAvailable: boolean;
  meAvailable: boolean;
  participated: boolean | null;
  me: ContestRankEntry | null;
  leaders: ContestRankEntry[];
}

export interface SubmissionContent {
  code: string;
  language: string;
  compileAndRunOptions?: JsonObject;
}

export interface SubmissionTestcaseSummary {
  hash: string;
  status: unknown;
  time: unknown;
  memory: unknown;
  checkerMessage: unknown;
  userError: unknown;
}

export interface SubmissionSummary {
  submissionId: unknown;
  status: unknown;
  score: unknown;
  displayScore: unknown;
  timeUsed: unknown;
  memoryUsed: unknown;
  progressType: unknown;
  compile: {
    success: unknown;
    message: unknown;
  };
  testcases: SubmissionTestcaseSummary[];
}

export interface SubmissionRecord {
  submissionId: unknown;
  status: unknown;
  score: unknown;
  displayScore: unknown;
  language: unknown;
  submittedAt: unknown;
  timeUsed: unknown;
  memoryUsed: unknown;
  problem: {
    displayId: unknown;
    contestId: unknown;
    order: unknown;
    title: unknown;
  };
}

export interface SubmissionListSummary {
  username: string;
  hasOlder: boolean | null;
  hasNewer: boolean | null;
  submissions: SubmissionRecord[];
}

export interface SubmitResult {
  submissionId: number;
  target: ProblemTarget;
  problem: JsonObject;
  response: JsonObject;
}

export type XpuojErrorCode =
  | "AUTH_REQUIRED"
  | "PERMISSION_DENIED"
  | "INVALID_ARGUMENT"
  | "INVALID_RESPONSE"
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "NOT_SUBMITTABLE"
  | "LANGUAGE_NOT_ALLOWED";

export class XpuojError extends Error {
  readonly code: XpuojErrorCode;
  readonly status?: number;

  constructor(code: XpuojErrorCode, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "XpuojError";
    this.code = code;
    this.status = options?.status;
  }
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new XpuojError("INVALID_ARGUMENT", `${label} must be a positive integer`);
  }
  return value;
}

export function normalizeApiBase(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new XpuojError("INVALID_ARGUMENT", "XPUOJ API base cannot be empty");
  }
  return trimmed.endsWith("/api") ? `${trimmed}/` : `${trimmed}/api/`;
}

function targetFromUrl(value: string): ProblemTarget {
  let url: URL;
  try {
    url = new URL(value, DEFAULT_SITE);
  } catch (error) {
    throw new XpuojError(
      "INVALID_ARGUMENT",
      `unsupported XPUOJ target: ${value}`,
      { cause: error }
    );
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname !== "xpuoj.com" && !hostname.endsWith(".xpuoj.com")) {
    throw new XpuojError("INVALID_ARGUMENT", `target is not an xpuoj.com URL: ${value}`);
  }

  const ordinaryMatch = url.pathname.match(/^\/p\/(\d+)\/?$/);
  if (ordinaryMatch?.[1]) {
    return {
      kind: "ordinary",
      displayId: positiveInteger(Number(ordinaryMatch[1]), "problem display ID")
    };
  }

  const contestPatterns = [
    /^\/contest\/(\d+)\/(?:problem|p)\/(\d+)\/?$/,
    /^\/c\/(\d+)\/(?:problem|p)?\/?(\d+)\/?$/
  ];
  for (const pattern of contestPatterns) {
    const match = url.pathname.match(pattern);
    if (match?.[1] && match[2]) {
      return {
        kind: "contest",
        contestId: positiveInteger(Number(match[1]), "contest ID"),
        problemOrder: positiveInteger(Number(match[2]), "problem order")
      };
    }
  }

  const queryContestId = url.searchParams.get("contestId");
  const queryProblemOrder =
    url.searchParams.get("problemOrder") ?? url.searchParams.get("order");
  if (queryContestId && queryProblemOrder) {
    return {
      kind: "contest",
      contestId: positiveInteger(Number(queryContestId), "contest ID"),
      problemOrder: positiveInteger(Number(queryProblemOrder), "problem order")
    };
  }

  throw new XpuojError(
    "INVALID_ARGUMENT",
    "URL must identify /p/<display-id> or include a contest ID and problem order"
  );
}

export function resolveContestId(input: ContestTargetInput): number {
  const hasTarget = typeof input.target === "string" && input.target.trim().length > 0;
  const hasContestId = input.contestId !== undefined;
  if (Number(hasTarget) + Number(hasContestId) !== 1) {
    throw new XpuojError(
      "INVALID_ARGUMENT",
      "provide exactly one contest URL or contest ID"
    );
  }

  if (hasContestId) {
    return positiveInteger(input.contestId ?? 0, "contest ID");
  }

  const target = input.target?.trim();
  if (target === undefined) {
    throw new XpuojError("INVALID_ARGUMENT", "contest target cannot be empty");
  }
  if (/^\d+$/.test(target)) {
    return positiveInteger(Number(target), "contest ID");
  }

  let url: URL;
  try {
    url = new URL(target);
  } catch (error) {
    throw new XpuojError("INVALID_ARGUMENT", "contest must be an XPUOJ URL or ID", {
      cause: error
    });
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "xpuoj.com" && !hostname.endsWith(".xpuoj.com")) {
    throw new XpuojError("INVALID_ARGUMENT", "contest URL must be on xpuoj.com");
  }
  const match = url.pathname.match(/^\/(?:contest|c)\/(\d+)(?:\/|$)/);
  if (!match?.[1]) {
    throw new XpuojError("INVALID_ARGUMENT", "contest URL does not contain a contest ID");
  }
  return positiveInteger(Number(match[1]), "contest ID");
}

export function resolveProblemTarget(input: ProblemTargetInput): ProblemTarget {
  const hasTarget = typeof input.target === "string" && input.target.trim().length > 0;
  const hasOrdinary = input.problemId !== undefined;
  const hasContest = input.contestId !== undefined || input.problemOrder !== undefined;
  const modes = Number(hasTarget) + Number(hasOrdinary) + Number(hasContest);

  if (modes !== 1) {
    throw new XpuojError(
      "INVALID_ARGUMENT",
      "provide exactly one target: URL, problemId, or contestId with problemOrder"
    );
  }

  if (hasTarget) {
    const target = input.target?.trim();
    if (target === undefined) {
      throw new XpuojError("INVALID_ARGUMENT", "target cannot be empty");
    }
    if (/^\d+$/.test(target)) {
      return {
        kind: "ordinary",
        displayId: positiveInteger(Number(target), "problem display ID")
      };
    }
    return targetFromUrl(target);
  }

  if (hasOrdinary) {
    return {
      kind: "ordinary",
      displayId: positiveInteger(input.problemId ?? 0, "problem display ID")
    };
  }

  if (input.contestId === undefined || input.problemOrder === undefined) {
    throw new XpuojError(
      "INVALID_ARGUMENT",
      "contestId and problemOrder must be provided together"
    );
  }
  return {
    kind: "contest",
    contestId: positiveInteger(input.contestId, "contest ID"),
    problemOrder: positiveInteger(input.problemOrder, "problem order")
  };
}

export function describeTarget(target: ProblemTarget): string {
  return target.kind === "ordinary"
    ? `problem=/p/${target.displayId}`
    : `contest=${target.contestId} problem=${target.problemOrder}`;
}

function contestProblemPayload(
  target: Extract<ProblemTarget, { kind: "contest" }>,
  locale: string
): JsonObject {
  return {
    contestId: target.contestId,
    problemOrder: target.problemOrder,
    localizedContentsOfLocale: locale,
    samples: true,
    judgeInfo: true,
    judgeInfoToBePreprocessed: true,
    lastSubmissionAndLastAcceptedSubmission: true
  };
}

function ordinaryProblemPayload(
  target: Extract<ProblemTarget, { kind: "ordinary" }>,
  locale: string
): JsonObject {
  return {
    displayId: target.displayId,
    localizedContentsOfLocale: locale,
    tagsOfLocale: locale,
    samples: true,
    judgeInfo: true,
    judgeInfoToBePreprocessed: true,
    statistics: true,
    discussionCount: true,
    permissionOfCurrentUser: true,
    lastSubmissionAndLastAcceptedSubmission: true
  };
}

function errorStrings(value: unknown, depth = 0): string[] {
  if (depth > 3) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => errorStrings(entry, depth + 1));
  }
  if (isRecord(value)) {
    const preferredKeys = ["code", "error", "message", "status"];
    const preferred = preferredKeys.flatMap((key) => errorStrings(value[key], depth + 1));
    if (preferred.length > 0) {
      return preferred;
    }
    return Object.values(value).flatMap((entry) => errorStrings(entry, depth + 1));
  }
  return [];
}

function apiError(error: unknown): XpuojError {
  const strings = errorStrings(error).map((value) => value.trim()).filter(Boolean);
  const authCode = strings.find((value) => AUTHENTICATION_ERRORS.has(value.toUpperCase()));
  if (authCode) {
    return new XpuojError(
      "PERMISSION_DENIED",
      "Your XPUOJ sign-in is no longer valid. Sign in again and retry."
    );
  }
  return new XpuojError(
    "INVALID_RESPONSE",
    "XPUOJ could not complete the request. Please try again."
  );
}

async function boundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_JSON_RESPONSE_BYTES) {
    throw new XpuojError(
      "INVALID_RESPONSE",
      "XPUOJ returned more data than this client can safely process."
    );
  }
  const text = await response.text();
  if (text.length > MAX_JSON_RESPONSE_BYTES) {
    throw new XpuojError(
      "INVALID_RESPONSE",
      "XPUOJ returned more data than this client can safely process."
    );
  }
  return text;
}

export async function discoverApiBase(
  site = DEFAULT_SITE,
  fetchFn: typeof fetch = fetch,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
): Promise<string> {
  try {
    const response = await fetchFn(site, {
      headers: {
        "User-Agent": "xpuoj-cli"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      return normalizeApiBase(DEFAULT_API_ROOT);
    }
    const html = await boundedResponseText(response);
    const patterns = [
      /try\{c="(https?:\/\/[^"\\]+)"\}/,
      /apiEndpoint\s*=\s*["'](https?:\/\/[^"']+)/
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return normalizeApiBase(match[1]);
      }
    }
  } catch {
    // The known API root is the deterministic fallback when frontend discovery is unavailable.
  }
  return normalizeApiBase(DEFAULT_API_ROOT);
}

export class XpuojClient {
  readonly apiBase: string;
  readonly timeoutMs: number;
  readonly token: string;
  readonly fetchFn: typeof fetch;

  constructor(options: {
    apiBase: string;
    token: string;
    timeoutMs?: number;
    fetchFn?: typeof fetch;
  }) {
    if (!options.token.trim()) {
      throw new XpuojError(
        "AUTH_REQUIRED",
        "An active local XPUOJ browser sign-in or XPUOJ_TOKEN is required."
      );
    }
    this.apiBase = normalizeApiBase(options.apiBase);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const providedFetch = options.fetchFn;
    this.fetchFn = providedFetch
      ? (input, init) => providedFetch(input, init)
      : (input, init) => fetch(input, init);
  }

  private async request(endpoint: string, init: RequestInit): Promise<JsonObject> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.apiBase}${endpoint}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "User-Agent": "xpuoj",
          ...(init.headers ?? {})
        },
        signal: init.signal ?? AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new XpuojError(
        "NETWORK_ERROR",
        "Could not reach XPUOJ. Check your connection and try again.",
        { cause: error }
      );
    }

    const text = await boundedResponseText(response);
    if (!response.ok) {
      throw new XpuojError(
        response.status === 401 || response.status === 403 ? "PERMISSION_DENIED" : "HTTP_ERROR",
        response.status === 401 || response.status === 403
          ? "Your XPUOJ sign-in is no longer valid. Sign in again and retry."
          : `XPUOJ could not complete the request (status ${response.status}).`,
        { status: response.status }
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new XpuojError(
        "INVALID_RESPONSE",
        "XPUOJ returned an unreadable response.",
        { cause: error }
      );
    }
    if (!isRecord(parsed)) {
      throw new XpuojError(
        "INVALID_RESPONSE",
        "XPUOJ returned an unsupported response."
      );
    }
    if (parsed.error !== undefined && parsed.error !== null && parsed.error !== "") {
      throw apiError(parsed.error);
    }
    return parsed;
  }

  async post(endpoint: string, payload: JsonObject): Promise<JsonObject> {
    return this.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }

  async get(endpoint: string): Promise<JsonObject> {
    return this.request(endpoint, { method: "GET" });
  }

  async getCurrentUsername(): Promise<string> {
    // XPUOJ's session bootstrap endpoint reads the bearer token from the query
    // string. Other API endpoints use the Authorization header, so retain that
    // header while passing the bootstrap token in the form the browser uses.
    const session = await this.get(
      `auth/getSessionInfo?${new URLSearchParams({ token: this.token }).toString()}`
    );
    const userMeta = isRecord(session.userMeta) ? session.userMeta : {};
    const username = typeof userMeta.username === "string" ? userMeta.username.trim() : "";
    if (!username) {
      throw new XpuojError("PERMISSION_DENIED", "XPUOJ did not return the signed-in username.");
    }
    return username;
  }

  async getProblem(target: ProblemTarget, locale = "zh_CN"): Promise<JsonObject> {
    if (target.kind === "contest") {
      return this.post("contest/play/getProblem", contestProblemPayload(target, locale));
    }
    return this.post("problem/getProblem", ordinaryProblemPayload(target, locale));
  }

  async getSubmissionDetail(submissionId: number, locale = "zh_CN"): Promise<JsonObject> {
    return this.post("submission/getSubmissionDetail", {
      submissionId: String(positiveInteger(submissionId, "submission ID")),
      locale
    });
  }

  async listSubmissions(
    target: SubmissionScope | undefined,
    options: {
      locale?: string;
      takeCount?: number;
      maxId?: number;
      language?: string;
    } = {}
  ): Promise<{ username: string; response: JsonObject }> {
    const takeCount = options.takeCount ?? 20;
    if (!Number.isSafeInteger(takeCount) || takeCount < 1 || takeCount > 50) {
      throw new XpuojError("INVALID_ARGUMENT", "submission count must be between 1 and 50");
    }
    const maxId = options.maxId;
    if (maxId !== undefined) {
      positiveInteger(maxId, "maximum submission ID");
    }
    const username = await this.getCurrentUsername();
    const common: JsonObject = {
      locale: options.locale ?? "zh_CN",
      submitter: username,
      takeCount,
      ...(maxId === undefined ? {} : { maxId }),
      ...(options.language?.trim() ? { codeLanguage: options.language.trim() } : {})
    };
    if (target?.kind === "contest") {
      return {
        username,
        response: await this.post("contest/play/querySubmissions", {
        ...common,
        contestId: target.contestId,
        problemOrder: target.problemOrder
        })
      };
    }
    if (target?.kind === "contest-all") {
      const contest = await this.post("contest/getContestProblems", {
        contestId: target.contestId,
        locale: options.locale ?? "zh_CN"
      });
      const problems = Array.isArray(contest.problems)
        ? contest.problems.filter(isRecord)
        : [];
      const orders = problems.flatMap((problem) => {
        const order = problem.order;
        return typeof order === "number" && Number.isSafeInteger(order) && order > 0
          ? [order]
          : [];
      });
      const responses = await Promise.all(
        orders.map(async (problemOrder) => {
          const response = await this.post("contest/play/querySubmissions", {
            ...common,
            contestId: target.contestId,
            problemOrder
          });
          const submissions: JsonObject[] = Array.isArray(response.submissions)
            ? response.submissions.filter(isRecord).map((submission): JsonObject => ({
                ...submission,
                contestId: target.contestId,
                contestProblemOrder: problemOrder
              }))
            : [];
          return { response, submissions };
        })
      );
      const submissions = responses
        .flatMap(({ submissions }) => submissions)
        .sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0));
      return {
        username,
        response: {
          submissions: submissions.slice(0, takeCount),
          hasSmallerId:
            submissions.length > takeCount ||
            responses.some(({ response }) => response.hasSmallerId === true)
        }
      };
    }
    if (target?.kind === "ordinary") {
      const problem = await this.getProblem(target, options.locale);
      return {
        username,
        response: await this.post("submission/querySubmission", {
        ...common,
        problemId: ordinaryProblemRealId(problem, target.displayId)
        })
      };
    }
    return { username, response: await this.post("submission/querySubmission", common) };
  }

  async getContestScoreboard(
    contestId: number,
    takeCount = 10,
    skipCount = 0
  ): Promise<JsonObject> {
    const normalizedTakeCount = positiveInteger(takeCount, "ranking size");
    if (normalizedTakeCount > 50) {
      throw new XpuojError("INVALID_ARGUMENT", "ranking size cannot exceed 50");
    }
    if (!Number.isSafeInteger(skipCount) || skipCount < 0) {
      throw new XpuojError("INVALID_ARGUMENT", "ranking offset cannot be negative");
    }
    return this.post("contest/play/getContestScoreboard", {
      contestId: positiveInteger(contestId, "contest ID"),
      skipCount,
      takeCount: normalizedTakeCount
    });
  }

  async getContestScoreboardMe(contestId: number): Promise<JsonObject> {
    return this.post("contest/play/getContestScoreboardMe", {
      contestId: positiveInteger(contestId, "contest ID")
    });
  }

  async submitSolution(
    target: ProblemTarget,
    content: SubmissionContent,
    locale = "zh_CN"
  ): Promise<SubmitResult> {
    if (!content.code.trim()) {
      throw new XpuojError("INVALID_ARGUMENT", "refusing to submit empty source code");
    }
    if (!content.language.trim()) {
      throw new XpuojError("INVALID_ARGUMENT", "submission language cannot be empty");
    }

    const problem = await this.getProblem(target, locale);
    const allowedLanguages = getAllowedSubmissionLanguages(problem);
    if (allowedLanguages.length > 0 && !allowedLanguages.includes(content.language)) {
      throw new XpuojError(
        "LANGUAGE_NOT_ALLOWED",
        `language ${content.language} is not allowed; choose one of: ${allowedLanguages.join(", ")}`
      );
    }

    const submissionContent = {
      code: content.code,
      language: content.language,
      compileAndRunOptions: content.compileAndRunOptions ?? {}
    };

    const response =
      target.kind === "contest"
        ? await this.post("contest/play/submit", {
            contestId: target.contestId,
            problemOrder: target.problemOrder,
            content: submissionContent
          })
        : await this.post("submission/submit", {
            problemId: ordinaryProblemRealId(problem, target.displayId),
            content: submissionContent
          });

    const rawSubmissionId = response.submissionId;
    const submissionId =
      typeof rawSubmissionId === "number"
        ? rawSubmissionId
        : typeof rawSubmissionId === "string"
          ? Number(rawSubmissionId)
          : Number.NaN;
    if (!Number.isSafeInteger(submissionId) || submissionId <= 0) {
      throw new XpuojError(
        "INVALID_RESPONSE",
        "XPUOJ submission did not return a valid submission ID"
      );
    }
    return {
      submissionId,
      target,
      problem,
      response
    };
  }
}

function ordinaryProblemRealId(problem: JsonObject, displayId: number): number {
  const meta = isRecord(problem.meta) ? problem.meta : {};
  const rawProblemId = meta.id;
  const problemId =
    typeof rawProblemId === "number"
      ? rawProblemId
      : typeof rawProblemId === "string"
        ? Number(rawProblemId)
        : Number.NaN;
  if (!Number.isSafeInteger(problemId) || problemId <= 0) {
    throw new XpuojError(
      "INVALID_RESPONSE",
      `problem /p/${displayId} did not return a valid immutable problem ID`
    );
  }
  if (problem.submittable === false) {
    throw new XpuojError("NOT_SUBMITTABLE", `problem /p/${displayId} is not submittable`);
  }
  return problemId;
}

export function getAllowedSubmissionLanguages(problem: JsonObject): string[] {
  const judgeInfo = isRecord(problem.judgeInfo) ? problem.judgeInfo : {};
  const languages = judgeInfo.allowedSubmissionLanguages;
  if (!Array.isArray(languages)) {
    return [];
  }
  return languages.filter((language): language is string => typeof language === "string");
}

export function summarizeProblem(problem: JsonObject): JsonObject {
  const meta = isRecord(problem.meta) ? problem.meta : {};
  const localized = isRecord(problem.localizedContentsOfLocale)
    ? problem.localizedContentsOfLocale
    : {};
  const judgeInfo = isRecord(problem.judgeInfo) ? problem.judgeInfo : {};
  const sections = Array.isArray(localized.contentSections)
    ? localized.contentSections
        .map((section, index) => {
          if (!isRecord(section)) {
            return String(index);
          }
          const value = section.title ?? section.type ?? index;
          return String(value);
        })
    : [];
  return {
    title: localized.title,
    order: meta.order,
    type: meta.type,
    submittable: problem.submittable,
    locale: localized.locale,
    languages: getAllowedSubmissionLanguages(problem),
    timeLimit: judgeInfo.timeLimit,
    memoryLimit: judgeInfo.memoryLimit,
    sections,
    sampleCount: Array.isArray(problem.samples) ? problem.samples.length : 0
  };
}

export function summarizeSubmission(detail: JsonObject): SubmissionSummary {
  const meta = isRecord(detail.meta) ? detail.meta : {};
  const progress = isRecord(detail.progress) ? detail.progress : {};
  const compile = isRecord(progress.compile) ? progress.compile : {};
  const testcaseResult = isRecord(progress.testcaseResult) ? progress.testcaseResult : {};
  const testcases = Object.entries(testcaseResult).map(([hash, rawResult]) => {
    const result = isRecord(rawResult) ? rawResult : {};
    return {
      hash,
      status: result.status,
      time: result.time,
      memory: result.memory,
      checkerMessage: result.checkerMessage,
      userError: result.userError
    };
  });
  return {
    submissionId: meta.id,
    status: meta.status,
    score: meta.score,
    displayScore: meta.displayScore,
    timeUsed: meta.timeUsed,
    memoryUsed: meta.memoryUsed,
    progressType: progress.progressType,
    compile: {
      success: compile.success,
      message: compile.message
    },
    testcases
  };
}

export function summarizeSubmissionList(
  response: JsonObject,
  username: string
): SubmissionListSummary {
  const rawSubmissions = Array.isArray(response.submissions) ? response.submissions : [];
  return {
    username,
    hasOlder: typeof response.hasSmallerId === "boolean" ? response.hasSmallerId : null,
    hasNewer: typeof response.hasLargerId === "boolean" ? response.hasLargerId : null,
    submissions: rawSubmissions.filter(isRecord).map((submission) => {
      const problem = isRecord(submission.problem) ? submission.problem : {};
      return {
        submissionId: submission.id,
        status: submission.status,
        score: submission.score,
        displayScore: submission.displayScore,
        language: submission.codeLanguage,
        submittedAt: submission.submitTime,
        timeUsed: submission.timeUsed,
        memoryUsed: submission.memoryUsed,
        problem: {
          displayId: problem.displayId,
          contestId: submission.contestId,
          order: submission.contestProblemOrder ?? problem.order,
          title: submission.problemTitle
        }
      };
    })
  };
}

function contestRankEntry(value: unknown): ContestRankEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const numeric = (raw: unknown): number | null => {
    if (
      (typeof raw !== "number" && typeof raw !== "string") ||
      (typeof raw === "string" && raw.trim() === "")
    ) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const rank = numeric(value.rank);
  const score = numeric(value.totalScore);
  if (rank === null || !Number.isSafeInteger(rank) || rank <= 0 || score === null) {
    return null;
  }
  const userMeta = isRecord(value.userMeta) ? value.userMeta : {};
  const nickname =
    typeof userMeta.nickname === "string" ? userMeta.nickname.trim() : "";
  const username =
    typeof userMeta.username === "string" ? userMeta.username.trim() : "";
  const penalty = numeric(value.penalty);
  const user = (nickname || username || "Participant")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return {
    rank,
    user,
    score,
    penalty
  };
}

export function summarizeContestRanking(
  contestId: number,
  leaderboard: JsonObject | null,
  mine: JsonObject | null
): ContestRankingSummary {
  const entries = Array.isArray(leaderboard?.scoreboard)
    ? leaderboard.scoreboard
        .map(contestRankEntry)
        .filter((entry): entry is ContestRankEntry => entry !== null)
    : [];
  const rawTotal =
    typeof leaderboard?.total === "number" ||
    (typeof leaderboard?.total === "string" && leaderboard.total.trim() !== "")
      ? Number(leaderboard.total)
      : Number.NaN;
  const myEntry = contestRankEntry(mine?.entry);
  const notParticipated =
    mine?.notParticipated === true || (mine !== null && mine.entry == null);
  return {
    contestId: positiveInteger(contestId, "contest ID"),
    total:
      Number.isSafeInteger(rawTotal) && rawTotal >= 0
        ? rawTotal
        : null,
    leaderboardAvailable: leaderboard !== null,
    meAvailable: mine !== null,
    participated: mine === null ? null : !notParticipated,
    me: myEntry,
    leaders: entries
  };
}

export async function getContestRanking(
  client: XpuojClient,
  contestId: number,
  takeCount = 10
): Promise<ContestRankingSummary> {
  const [leaderboardResult, mineResult] = await Promise.allSettled([
    client.getContestScoreboard(contestId, takeCount),
    client.getContestScoreboardMe(contestId)
  ]);
  if (leaderboardResult.status === "rejected" && mineResult.status === "rejected") {
    throw mineResult.reason;
  }
  return summarizeContestRanking(
    contestId,
    leaderboardResult.status === "fulfilled" ? leaderboardResult.value : null,
    mineResult.status === "fulfilled" ? mineResult.value : null
  );
}

export function isSubmissionFinished(summary: SubmissionSummary): boolean {
  return (
    summary.progressType === "Finished" ||
    (typeof summary.status === "string" && TERMINAL_STATUSES.has(summary.status))
  );
}

export async function waitForSubmission(
  client: XpuojClient,
  submissionId: number,
  options: {
    locale?: string;
    intervalMs?: number;
    timeoutMs?: number;
    onUpdate?: (summary: SubmissionSummary) => void;
  } = {}
): Promise<SubmissionSummary> {
  const intervalMs = options.intervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const detail = await client.getSubmissionDetail(submissionId, options.locale);
    const summary = summarizeSubmission(detail);
    options.onUpdate?.(summary);
    if (isSubmissionFinished(summary)) {
      return summary;
    }
    if (Date.now() >= deadline) {
      throw new XpuojError(
        "NETWORK_ERROR",
        `Submission ${submissionId} is still judging after ${Math.ceil(timeoutMs / 1_000)} seconds.`
      );
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof XpuojError) {
    return {
      code: error.code,
      message: error.message
    };
  }
  return {
    code: "OPERATION_FAILED",
    message: "The operation could not be completed. Please try again."
  };
}
