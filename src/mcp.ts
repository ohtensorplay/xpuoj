import { createInterface } from "node:readline";

import {
  DEFAULT_SITE_URL,
  launchBrowser,
  normalizeSiteUrl,
  normalizeXpuojPage
} from "./browser.js";
import {
  BrowserRelay,
  BrowserRpcError,
  type JsonRpcId,
  type JsonRpcRequest
} from "./relay.js";

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
}

interface LocalMcpOptions {
  siteUrl?: string;
  relayPort?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  openBrowser?: boolean;
  launch?: (url: string) => Promise<boolean>;
}

interface LocalMcpBridgeOptions extends LocalMcpOptions {
  relay: BrowserRelay;
  send: (message: unknown) => void;
}

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {}
};

export const BROWSER_TOOLS: readonly McpTool[] = [
  {
    name: "oj_status",
    description:
      "Report the current XPUOJ page, contest, problem, and current-user score status.",
    inputSchema: EMPTY_OBJECT_SCHEMA
  },
  {
    name: "get_problem_description",
    description:
      "Get the currently opened problem statement as readable Markdown, including visible samples, limits, and language metadata.",
    inputSchema: EMPTY_OBJECT_SCHEMA
  },
  {
    name: "list_current_problem_languages",
    description:
      "List the submission language IDs available for the opened problem.",
    inputSchema: EMPTY_OBJECT_SCHEMA
  },
  {
    name: "search_problems",
    description:
      "Search ordinary XPUOJ problems. IDs are strings such as \"1001\" or \"P1234\".",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keyword or problem ID text."
        },
        limit: {
          type: "number",
          description: "Maximum results, 1-50. Defaults to 10."
        }
      },
      required: ["query"]
    }
  },
  {
    name: "list_problems",
    description:
      "List ordinary XPUOJ problems visible in the problem set.",
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "number",
          description: "1-based page number. Defaults to 1."
        },
        limit: {
          type: "number",
          description: "Maximum results, 1-50. Defaults to 20."
        },
        keyword: {
          type: "string",
          description: "Optional title or ID keyword."
        }
      }
    }
  },
  {
    name: "switch_problem",
    description:
      "Switch the web page to an ordinary problem by an ID returned from search_problems or list_problems.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Problem ID string, for example \"1001\" or \"P1234\"."
        }
      },
      required: ["id"]
    }
  },
  {
    name: "list_contest_problems",
    description:
      "List problems in the contest currently open in the browser.",
    inputSchema: EMPTY_OBJECT_SCHEMA
  },
  {
    name: "switch_contest_problem",
    description:
      "Switch to a problem in the currently open contest by problem order.",
    inputSchema: {
      type: "object",
      properties: {
        problemOrder: {
          type: "number",
          description: "Positive contest problem number."
        }
      },
      required: ["problemOrder"]
    }
  },
  {
    name: "get_current_editor_code",
    description:
      "Get code currently typed in the browser editor, optionally sliced by 1-based lines.",
    inputSchema: {
      type: "object",
      properties: {
        withLineNumbers: { type: "boolean" },
        startLine: { type: "number" },
        lineCount: { type: "number" }
      }
    }
  },
  {
    name: "set_current_editor_language",
    description:
      "Switch the browser submission editor to an available language.",
    inputSchema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          description: "Language ID from list_current_problem_languages."
        }
      },
      required: ["language"]
    }
  },
  {
    name: "set_current_editor_code",
    description:
      "Replace the code currently typed in the browser submission editor.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Exact source code to put into the editor."
        }
      },
      required: ["code"]
    }
  },
  {
    name: "apply_current_editor_code_patch",
    description:
      "Apply a unified diff to the code visible in the browser submission editor.",
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description: "Unified diff text for the current editor code."
        }
      },
      required: ["patch"]
    }
  },
  {
    name: "list_my_submissions",
    description:
      "List the current user's recent submissions for the opened problem.",
    inputSchema: {
      type: "object",
      properties: {
        codeLanguage: { type: "string" },
        takeCount: {
          type: "number",
          description: "Maximum submissions to return. Defaults to 10."
        }
      }
    }
  },
  {
    name: "get_submission_overview",
    description:
      "Get verdict, score, language, time, and memory for a visible submission.",
    inputSchema: {
      type: "object",
      properties: {
        submissionId: { type: "string" }
      },
      required: ["submissionId"]
    }
  },
  {
    name: "get_submission_detail",
    description:
      "Get source, overall judge details, a sample, or a testcase for a visible submission.",
    inputSchema: {
      type: "object",
      properties: {
        submissionId: { type: "string" },
        section: {
          type: "string",
          enum: ["overall", "code", "sample", "testcase"]
        },
        sampleIndex: { type: "number" },
        subtaskIndex: { type: "number" },
        testcaseIndex: { type: "number" },
        include: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "input",
              "output",
              "userOutput",
              "userError",
              "checkerMessage",
              "interactorMessage",
              "systemMessage",
              "all"
            ]
          }
        }
      },
      required: ["submissionId", "section"]
    }
  },
  {
    name: "submit_code",
    description:
      "Submit the language and exact source already visible in the browser editor. XPUOJ applies the user's configured confirmation mode.",
    inputSchema: {
      type: "object",
      properties: {
        skipSamples: { type: "boolean" }
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  }
];

const LOCAL_TOOLS: readonly McpTool[] = [
  {
    name: "xpuoj_open_page",
    description:
      "Open an XPUOJ URL in the default browser. After a new page loads, press Ctrl+B and Connect if the relay is not already connected. In Chrome or Edge, allow Local network access when prompted.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "An absolute XPUOJ URL or a site-relative path such as /p/1001."
        }
      }
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: "xpuoj_connection_status",
    description:
      "Check whether the local plugin is connected to an XPUOJ browser tab.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }
];

const ALL_TOOLS = [...LOCAL_TOOLS, ...BROWSER_TOOLS];
const BROWSER_TOOL_NAMES = new Set(BROWSER_TOOLS.map(({ name }) => name));

function isAddressInUse(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}

async function createListeningRelay(
  siteUrl: URL,
  options: LocalMcpOptions
): Promise<BrowserRelay> {
  const relayOptions = {
    allowedOrigin: siteUrl.origin,
    port: options.relayPort ?? 7423,
    requestTimeoutMs: options.requestTimeoutMs
  };
  let relay = new BrowserRelay(relayOptions);
  try {
    await relay.listen();
    return relay;
  } catch (error) {
    if (!isAddressInUse(error)) {
      throw error;
    }
  }

  relay = new BrowserRelay({
    ...relayOptions,
    port: 0
  });
  await relay.listen();
  process.stderr.write(
    `XPUOJ relay port ${relayOptions.port} is already in use; using ${relay.baseUrl} instead.\n`
  );
  return relay;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcResult(id: JsonRpcId, result: unknown): unknown {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): unknown {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

function textToolResult(text: string, isError = false): unknown {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {})
  };
}

export class LocalMcpBridge {
  private readonly relay: BrowserRelay;
  private readonly send: (message: unknown) => void;
  private readonly siteUrl: URL;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly shouldOpenBrowser: boolean;
  private readonly launch: (url: string) => Promise<boolean>;
  private connectionPromptActive = false;

  constructor(options: LocalMcpBridgeOptions) {
    this.relay = options.relay;
    this.send = options.send;
    this.siteUrl = normalizeSiteUrl(options.siteUrl ?? DEFAULT_SITE_URL);
    this.connectTimeoutMs = options.connectTimeoutMs ?? 45_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.shouldOpenBrowser = options.openBrowser !== false;
    this.launch = options.launch ?? launchBrowser;
  }

  async handle(message: unknown): Promise<void> {
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      this.send(rpcError(null, -32600, "Invalid Request"));
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const id = hasId ? this.asId(message.id) : undefined;
    if (hasId && id === undefined) {
      this.send(rpcError(null, -32600, "Invalid Request"));
      return;
    }
    if (typeof message.method !== "string") {
      if (hasId) {
        this.send(rpcError(id ?? null, -32600, "Invalid Request"));
      }
      return;
    }

    if (!hasId) {
      return;
    }

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method: message.method,
      ...(message.params === undefined ? {} : { params: message.params })
    };
    const response = await this.dispatch(request);
    this.send(response);
  }

  private asId(value: unknown): JsonRpcId | undefined {
    return typeof value === "string" ||
      typeof value === "number" ||
      value === null
      ? value
      : undefined;
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    const id = request.id ?? null;
    try {
      switch (request.method) {
        case "initialize": {
          const params = isRecord(request.params) ? request.params : {};
          const protocolVersion =
            typeof params.protocolVersion === "string"
              ? params.protocolVersion
              : "2024-11-05";
          return rpcResult(id, {
            protocolVersion,
            capabilities: {
              resources: {},
              tools: {}
            },
            serverInfo: {
              name: "xpuoj-local-browser-bridge",
              version: "0.2.2"
            },
            instructions:
              "Use xpuoj_open_page for the requested XPUOJ URL. In the page, press Ctrl+B and Connect to the local relay. No browser extension is required."
          });
        }
        case "ping":
          return rpcResult(id, {});
        case "tools/list":
          return rpcResult(id, { tools: ALL_TOOLS });
        case "resources/list":
          return rpcResult(id, {
            resources: [
              {
                uri: "problem://current",
                name: "Current problem",
                description:
                  "The problem currently open in the connected XPUOJ tab.",
                mimeType: "application/json"
              }
            ]
          });
        case "resources/read":
          return rpcResult(
            id,
            await this.callBrowser("resources/read", request.params)
          );
        case "tools/call":
          return rpcResult(id, await this.callTool(request.params));
        default:
          return rpcError(id, -32601, `Method not found: ${request.method}`);
      }
    } catch (error) {
      if (error instanceof BrowserRpcError) {
        return rpcError(id, error.code, error.message, error.data);
      }
      return rpcError(
        id,
        -32603,
        error instanceof Error ? error.message : "Internal error"
      );
    }
  }

  private async callTool(params: unknown): Promise<unknown> {
    if (!isRecord(params) || typeof params.name !== "string") {
      return textToolResult("Missing MCP tool name.", true);
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (params.name === "xpuoj_connection_status") {
      return textToolResult(
        JSON.stringify(
          {
            connected: this.relay.isConnected,
            relayUrl: this.relay.baseUrl,
            next: this.relay.isConnected
              ? "The XPUOJ browser tab is ready."
              : "Open XPUOJ, press Ctrl+B, keep the relay URL shown here, leave pairing token empty, and click Connect. In Chrome or Edge, allow Local network access when prompted."
          },
          undefined,
          2
        )
      );
    }
    if (params.name === "xpuoj_open_page") {
      const rawUrl =
        typeof args.url === "string" ? args.url : this.siteUrl.toString();
      const page = normalizeXpuojPage(rawUrl, this.siteUrl);
      const opened = await this.launch(page.toString());
      this.connectionPromptActive = true;
      return textToolResult(
        opened
          ? `Opened ${page.toString()}. Press Ctrl+B in that tab and click Connect. In Chrome or Edge, allow Local network access when prompted. Relay URL: ${this.relay.baseUrl}`
          : `Open ${page.toString()} manually, press Ctrl+B, and click Connect. In Chrome or Edge, allow Local network access when prompted. Relay URL: ${this.relay.baseUrl}`,
        false
      );
    }
    if (!BROWSER_TOOL_NAMES.has(params.name)) {
      return textToolResult(`Unknown XPUOJ tool: ${params.name}`, true);
    }
    return this.callBrowser("tools/call", {
      name: params.name,
      arguments: args
    });
  }

  private async callBrowser(method: string, params: unknown): Promise<unknown> {
    if (!(await this.ensureBrowserConnection())) {
      return textToolResult(
        `XPUOJ browser relay is not connected. Open ${this.siteUrl.toString()}, press Ctrl+B, keep relay URL ${this.relay.baseUrl}, leave the pairing token empty, click Connect, and in Chrome or Edge allow Local network access when prompted, then retry.`,
        true
      );
    }
    this.connectionPromptActive = false;
    return this.relay.request(method, params, this.requestTimeoutMs);
  }

  private async ensureBrowserConnection(): Promise<boolean> {
    if (this.relay.isConnected) {
      return true;
    }
    if (!this.connectionPromptActive) {
      this.connectionPromptActive = true;
      process.stderr.write(
        `XPUOJ needs a browser connection. Press Ctrl+B in ${this.siteUrl.origin}, use ${this.relay.baseUrl}, leave the pairing token empty, and click Connect. In Chrome or Edge, allow Local network access when prompted.\n`
      );
      if (this.shouldOpenBrowser) {
        await this.launch(this.siteUrl.toString());
      }
    }
    return this.relay.waitForConnection(this.connectTimeoutMs);
  }
}

export async function runLocalMcp(
  options: LocalMcpOptions = {}
): Promise<void> {
  const siteUrl = normalizeSiteUrl(options.siteUrl ?? DEFAULT_SITE_URL);
  const relay = await createListeningRelay(siteUrl, options);

  const pending = new Set<Promise<void>>();
  const send = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const bridge = new LocalMcpBridge({
    ...options,
    relay,
    send,
    siteUrl: siteUrl.toString()
  });
  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false
  });

  lines.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send(rpcError(null, -32700, "Parse error"));
      return;
    }
    const task = bridge.handle(message).finally(() => {
      pending.delete(task);
    });
    pending.add(task);
  });

  await new Promise<void>((resolve) => {
    lines.once("close", resolve);
  });
  await relay.close();
  await Promise.allSettled(pending);
}
