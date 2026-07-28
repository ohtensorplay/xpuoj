import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, {
  WebSocketServer,
  type RawData
} from "ws";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface BrowserRelayOptions {
  allowedOrigin: string;
  host?: string;
  port?: number;
  pairingToken?: string;
  requestTimeoutMs?: number;
}

interface PollWaiter {
  response: ServerResponse;
  timer: NodeJS.Timeout;
}

interface RelaySession {
  id: string;
  transport: "poll" | "websocket";
  queue: JsonRpcRequest[];
  pollWaiter?: PollWaiter;
  socket?: WebSocket;
}

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  sessionId: string;
  timer: NodeJS.Timeout;
}

interface ConnectionWaiter {
  resolve: (connected: boolean) => void;
  timer: NodeJS.Timeout;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_POLL_TIMEOUT_MS = 25_000;

export class BrowserRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "BrowserRpcError";
    this.code = code;
    this.data = data;
  }
}

export class BrowserRelay {
  private readonly allowedOrigin: string;
  private readonly host: string;
  private readonly pairingToken: string;
  private readonly requestedPort: number;
  private readonly requestTimeoutMs: number;
  private readonly webSocketServer = new WebSocketServer({ noServer: true });
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly connectionWaiters = new Set<ConnectionWaiter>();
  private server: HttpServer | undefined;
  private session: RelaySession | undefined;
  private nextRequestId = 1;
  private listeningPort: number | undefined;

  constructor(options: BrowserRelayOptions) {
    this.allowedOrigin = new URL(options.allowedOrigin).origin;
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 7423;
    this.pairingToken = options.pairingToken ?? "";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  get isConnected(): boolean {
    return this.session !== undefined;
  }

  get port(): number {
    if (this.listeningPort === undefined) {
      throw new Error("The browser relay is not listening.");
    }
    return this.listeningPort;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async listen(): Promise<number> {
    if (this.server) {
      return this.port;
    }
    const server = createServer((request, response) => {
      void this.handleHttp(request, response).catch(() => {
        if (!response.headersSent) {
          this.writeJson(request, response, 500, {
            error: "internal_error"
          });
        } else {
          response.end();
        }
      });
    });
    this.server = server;
    server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.requestedPort, this.host);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not determine the browser relay address.");
    }
    this.listeningPort = address.port;
    return address.port;
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session) {
      this.closeSession(session, 1001, "relay closing");
    }
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The browser relay closed."));
      this.pendingRequests.delete(id);
    }
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    this.connectionWaiters.clear();

    const server = this.server;
    this.server = undefined;
    this.listeningPort = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  }

  waitForConnection(timeoutMs: number): Promise<boolean> {
    if (this.session) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: ConnectionWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.connectionWaiters.delete(waiter);
          resolve(false);
        }, timeoutMs)
      };
      this.connectionWaiters.add(waiter);
    });
  }

  request(
    method: string,
    params?: unknown,
    timeoutMs = this.requestTimeoutMs
  ): Promise<unknown> {
    const session = this.session;
    if (!session) {
      return Promise.reject(new Error("The XPUOJ browser is not connected."));
    }
    const id = this.nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method
    };
    if (params !== undefined) {
      request.params = params;
    }

    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        sessionId: session.id,
        timer: setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`The XPUOJ browser did not answer ${method} in time.`));
        }, timeoutMs)
      };
      this.pendingRequests.set(id, pending);
      try {
        this.sendToSession(session, request);
      } catch (error) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private isAllowedRequest(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    return (
      origin === this.allowedOrigin &&
      this.isLoopbackHost(request.headers.host) &&
      this.hasValidPairingToken(request)
    );
  }

  private isLoopbackHost(hostHeader: string | undefined): boolean {
    if (!hostHeader) {
      return false;
    }
    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
      return false;
    }
    return (
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "[::1]"
    );
  }

  private hasValidPairingToken(request: IncomingMessage): boolean {
    if (request.method === "OPTIONS") {
      return true;
    }
    if (!this.pairingToken) {
      return true;
    }
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`
    );
    const queryToken = requestUrl.searchParams.get("token");
    const authorization = request.headers.authorization;
    const bearerToken = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    return this.tokensMatch(queryToken ?? bearerToken ?? "");
  }

  private tokensMatch(candidate: string): boolean {
    const expected = Buffer.from(this.pairingToken);
    const actual = Buffer.from(candidate);
    return (
      expected.byteLength === actual.byteLength &&
      timingSafeEqual(expected, actual)
    );
  }

  private corsHeaders(_request: IncomingMessage): Record<string, string> {
    return {
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Origin": this.allowedOrigin,
      "Access-Control-Allow-Private-Network": "true",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Origin, Access-Control-Request-Private-Network"
    };
  }

  private writeJson(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    value: unknown
  ): void {
    response.writeHead(status, {
      ...this.corsHeaders(request),
      "Content-Type": "application/json; charset=utf-8"
    });
    response.end(JSON.stringify(value));
  }

  private writeEmpty(
    request: IncomingMessage,
    response: ServerResponse,
    status: number
  ): void {
    response.writeHead(status, this.corsHeaders(request));
    response.end();
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (!this.isAllowedRequest(request)) {
      response.writeHead(403, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8"
      });
      response.end(JSON.stringify({ error: "forbidden" }));
      return;
    }

    if (request.method === "OPTIONS") {
      this.writeEmpty(request, response, 204);
      return;
    }

    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`
    );
    if (requestUrl.pathname === "/bridge/hello") {
      await this.handleHello(request, response);
      return;
    }
    if (requestUrl.pathname === "/bridge/poll") {
      this.handlePoll(request, response, requestUrl);
      return;
    }
    if (requestUrl.pathname === "/bridge/respond") {
      await this.handleRespond(request, response);
      return;
    }
    this.writeJson(request, response, 404, { error: "not_found" });
  }

  private async handleHello(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (request.method !== "POST") {
      this.writeJson(request, response, 405, {
        error: "method_not_allowed"
      });
      return;
    }
    const payload = await this.readJson(request);
    if (
      !isRecord(payload) ||
      payload.client !== "lyrio-ui" ||
      !Array.isArray(payload.capabilities)
    ) {
      this.writeJson(request, response, 400, { error: "invalid_hello" });
      return;
    }
    const session: RelaySession = {
      id: randomUUID(),
      transport: "poll",
      queue: []
    };
    this.activateSession(session);
    this.writeJson(request, response, 200, { sessionId: session.id });
  }

  private handlePoll(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): void {
    if (request.method !== "GET") {
      this.writeJson(request, response, 405, {
        error: "method_not_allowed"
      });
      return;
    }
    const session = this.session;
    if (
      !session ||
      session.transport !== "poll" ||
      requestUrl.searchParams.get("sessionId") !== session.id
    ) {
      this.writeJson(request, response, 409, { error: "superseded" });
      return;
    }
    if (session.queue.length > 0) {
      this.writeJson(request, response, 200, {
        requests: session.queue.splice(0)
      });
      return;
    }
    if (session.pollWaiter) {
      clearTimeout(session.pollWaiter.timer);
      this.writeJson(request, session.pollWaiter.response, 409, {
        error: "poll_replaced"
      });
    }
    const requestedTimeout = Number(requestUrl.searchParams.get("timeout"));
    const timeoutMs =
      Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.min(requestedTimeout, MAX_POLL_TIMEOUT_MS)
        : 5_000;
    const waiter: PollWaiter = {
      response,
      timer: setTimeout(() => {
        if (session.pollWaiter === waiter) {
          session.pollWaiter = undefined;
        }
        this.writeEmpty(request, response, 204);
      }, timeoutMs)
    };
    session.pollWaiter = waiter;
    response.once("close", () => {
      if (session.pollWaiter === waiter && !response.writableEnded) {
        clearTimeout(waiter.timer);
        session.pollWaiter = undefined;
      }
    });
  }

  private async handleRespond(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (request.method !== "POST") {
      this.writeJson(request, response, 405, {
        error: "method_not_allowed"
      });
      return;
    }
    const payload = await this.readJson(request);
    const session = this.session;
    if (
      !session ||
      session.transport !== "poll" ||
      !isRecord(payload) ||
      payload.sessionId !== session.id ||
      !isJsonRpcResponse(payload.response)
    ) {
      this.writeJson(request, response, 409, { error: "superseded" });
      return;
    }
    this.acceptResponse(payload.response);
    this.writeEmpty(request, response, 204);
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`
    );
    if (
      requestUrl.pathname !== "/bridge/ws" ||
      !this.isAllowedRequest(request)
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.acceptWebSocket(webSocket);
    });
  }

  private acceptWebSocket(socket: WebSocket): void {
    const session: RelaySession = {
      id: randomUUID(),
      transport: "websocket",
      queue: [],
      socket
    };
    this.activateSession(session);
    socket.send(
      JSON.stringify({
        type: "hello",
        sessionId: session.id
      })
    );
    socket.on("message", (data) => {
      this.handleWebSocketMessage(session, data);
    });
    socket.on("close", () => {
      if (this.session === session) {
        this.session = undefined;
        this.rejectSessionRequests(
          session.id,
          new Error("The XPUOJ browser disconnected.")
        );
      }
    });
    socket.on("error", () => {
      if (this.session === session) {
        this.rejectSessionRequests(
          session.id,
          new Error("The XPUOJ browser connection failed.")
        );
      }
    });
  }

  private handleWebSocketMessage(
    session: RelaySession,
    data: RawData
  ): void {
    if (this.session !== session) {
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (
      isRecord(payload) &&
      payload.type === "response" &&
      isJsonRpcResponse(payload.response)
    ) {
      this.acceptResponse(payload.response);
    }
  }

  private activateSession(session: RelaySession): void {
    const previous = this.session;
    this.session = session;
    if (previous) {
      this.closeSession(previous, 4001, "superseded");
      this.rejectSessionRequests(
        previous.id,
        new Error("The XPUOJ browser connection was superseded.")
      );
    }
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
    this.connectionWaiters.clear();
  }

  private closeSession(
    session: RelaySession,
    code: number,
    reason: string
  ): void {
    if (session.pollWaiter) {
      clearTimeout(session.pollWaiter.timer);
      session.pollWaiter.response.writeHead(409, {
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Origin": this.allowedOrigin,
        "Access-Control-Allow-Private-Network": "true",
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        Vary: "Origin, Access-Control-Request-Private-Network"
      });
      session.pollWaiter.response.end(JSON.stringify({ error: "superseded" }));
      session.pollWaiter = undefined;
    }
    if (session.socket?.readyState === WebSocket.OPEN) {
      session.socket.close(code, reason);
    }
  }

  private sendToSession(
    session: RelaySession,
    request: JsonRpcRequest
  ): void {
    if (session.transport === "websocket") {
      if (session.socket?.readyState !== WebSocket.OPEN) {
        throw new Error("The XPUOJ browser WebSocket is not open.");
      }
      session.socket.send(JSON.stringify(request));
      return;
    }
    session.queue.push(request);
    const waiter = session.pollWaiter;
    if (waiter) {
      clearTimeout(waiter.timer);
      session.pollWaiter = undefined;
      waiter.response.writeHead(200, {
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Origin": this.allowedOrigin,
        "Access-Control-Allow-Private-Network": "true",
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        Vary: "Origin, Access-Control-Request-Private-Network"
      });
      waiter.response.end(
        JSON.stringify({
          requests: session.queue.splice(0)
        })
      );
    }
  }

  private acceptResponse(response: JsonRpcResponse): void {
    if (typeof response.id !== "number") {
      return;
    }
    const pending = this.pendingRequests.get(response.id);
    if (!pending || pending.sessionId !== this.session?.id) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.id);
    if (response.error) {
      pending.reject(
        new BrowserRpcError(
          response.error.code,
          response.error.message,
          response.error.data
        )
      );
      return;
    }
    pending.resolve(response.result);
  }

  private rejectSessionRequests(sessionId: string, error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.sessionId !== sessionId) {
        continue;
      }
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of request) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        throw new Error("Request body is too large.");
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || !("id" in value)) {
    return false;
  }
  const id = value.id;
  if (typeof id !== "string" && typeof id !== "number" && id !== null) {
    return false;
  }
  if ("error" in value) {
    const error = value.error;
    return (
      isRecord(error) &&
      typeof error.code === "number" &&
      typeof error.message === "string"
    );
  }
  return "result" in value;
}
