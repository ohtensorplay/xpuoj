import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { BROWSER_TOOLS, LocalMcpBridge } from "../dist/mcp.js";
import { BrowserRelay } from "../dist/relay.js";

const ORIGIN = "https://xpuoj.com";

async function withRelay(run) {
  const relay = new BrowserRelay({
    allowedOrigin: ORIGIN,
    port: 0,
    requestTimeoutMs: 2_000
  });
  await relay.listen();
  try {
    return await run(relay);
  } finally {
    await relay.close();
  }
}

function relayFetch(relay, path, options = {}) {
  return fetch(`${relay.baseUrl}${path}`, {
    ...options,
    headers: {
      Origin: ORIGIN,
      ...(options.headers ?? {})
    }
  });
}

async function connectLongPoll(relay) {
  const response = await relayFetch(relay, "/bridge/hello", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client: "lyrio-ui",
      capabilities: ["tools", "resources"]
    })
  });
  assert.equal(response.status, 200);
  return response.json();
}

const TOOL_ARGUMENTS = {
  oj_status: {},
  get_problem_description: {},
  list_current_problem_languages: {},
  search_problems: { query: "1", limit: 1 },
  list_problems: { page: 1, limit: 1 },
  switch_problem: { id: "1" },
  list_contest_problems: {},
  switch_contest_problem: { problemOrder: 1 },
  get_current_editor_code: { withLineNumbers: true },
  set_current_editor_language: { language: "cuda" },
  set_current_editor_code: { code: "extern \"C\" void run_kernel() {}" },
  apply_current_editor_code_patch: {
    patch: "@@ -1 +1 @@\n-old\n+new"
  },
  list_my_submissions: { takeCount: 1 },
  get_submission_overview: { submissionId: "test-submission" },
  get_submission_detail: {
    submissionId: "test-submission",
    section: "overall"
  },
  submit_code: { skipSamples: false }
};

function nextWebSocketJson(socket) {
  return once(socket, "message").then(([data]) => JSON.parse(data.toString()));
}

function nextJsonLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
    };
    const onData = (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("MCP stdout closed before a JSON response."));
    };
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

test("accepts Private Network Access preflights across browser families", async () => {
  await withRelay(async (relay) => {
    const userAgents = [
      "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
      "Mozilla/5.0 Firefox/141.0",
      "Mozilla/5.0 Version/18.5 Safari/605.1.15"
    ];
    for (const userAgent of userAgents) {
      const response = await relayFetch(relay, "/bridge/hello", {
        method: "OPTIONS",
        headers: {
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Private-Network": "true",
          "User-Agent": userAgent
        }
      });
      assert.equal(response.status, 204);
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        ORIGIN
      );
      assert.equal(
        response.headers.get("access-control-allow-private-network"),
        "true"
      );
    }
  });
});

test("rejects non-XPUOJ browser origins", async () => {
  await withRelay(async (relay) => {
    const response = await fetch(`${relay.baseUrl}/bridge/hello`, {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client: "lyrio-ui",
        capabilities: ["tools"]
      })
    });
    assert.equal(response.status, 403);
  });
});

test("forwards MCP requests and responses over long polling", async () => {
  await withRelay(async (relay) => {
    const { sessionId } = await connectLongPoll(relay);
    const pending = relay.request("tools/call", {
      name: "oj_status",
      arguments: {}
    });
    const poll = await relayFetch(
      relay,
      `/bridge/poll?sessionId=${encodeURIComponent(sessionId)}&timeout=1000`
    );
    assert.equal(poll.status, 200);
    const { requests } = await poll.json();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "tools/call");

    const browserResult = {
      content: [{ type: "text", text: "browser-ok" }]
    };
    const response = await relayFetch(relay, "/bridge/respond", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sessionId,
        response: {
          jsonrpc: "2.0",
          id: requests[0].id,
          result: browserResult
        }
      })
    });
    assert.equal(response.status, 204);
    assert.deepEqual(await pending, browserResult);
  });
});

test("forwards MCP requests and responses over WebSocket", async () => {
  await withRelay(async (relay) => {
    const socket = new WebSocket(
      relay.baseUrl.replace("http:", "ws:") + "/bridge/ws",
      { origin: ORIGIN }
    );
    const [helloData] = await once(socket, "message");
    const hello = JSON.parse(helloData.toString());
    assert.equal(hello.type, "hello");

    const browserRequestPromise = once(socket, "message");
    const pending = relay.request("resources/read", {
      uri: "problem://current"
    });
    const [requestData] = await browserRequestPromise;
    const request = JSON.parse(requestData.toString());
    assert.equal(request.method, "resources/read");

    socket.send(
      JSON.stringify({
        type: "response",
        response: {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            contents: [{ uri: "problem://current", text: "{}" }]
          }
        }
      })
    );
    assert.deepEqual(await pending, {
      contents: [{ uri: "problem://current", text: "{}" }]
    });
    socket.close();
    await once(socket, "close");
  });
});

test("answers MCP initialization locally before a browser connects", async () => {
  await withRelay(async (relay) => {
    const messages = [];
    const bridge = new LocalMcpBridge({
      relay,
      send: (message) => messages.push(message),
      openBrowser: false
    });

    await bridge.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18"
      }
    });
    await bridge.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    });

    assert.equal(messages[0].result.protocolVersion, "2025-06-18");
    assert.equal(
      messages[1].result.tools.some(
        ({ name }) => name === "get_problem_description"
      ),
      true
    );
    assert.equal(
      messages[1].result.tools.some(({ name }) => name === "xpuoj_open_page"),
      true
    );
  });
});

test("starts and handshakes when the preferred relay port is occupied", async (t) => {
  const blocker = createServer((_request, response) => response.end());
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  const address = blocker.address();
  assert.ok(address && typeof address !== "string");

  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
      "mcp",
      "--relay-port",
      String(address.port),
      "--no-open"
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => blocker.close(() => resolve()));
  });

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "startup-regression", version: "1.0.0" }
      }
    })}\n`
  );
  const response = await nextJsonLine(child.stdout);
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, "xpuoj-local-browser-bridge");

  child.stdin.end();
  const [code, signal] = await once(child, "exit");
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.match(stderr, /relay port \d+ is already in use; using http:\/\/127\.0\.0\.1:\d+/);
});

test("bridges a browser tool call end to end", async () => {
  await withRelay(async (relay) => {
    const { sessionId } = await connectLongPoll(relay);
    const messages = [];
    const bridge = new LocalMcpBridge({
      relay,
      send: (message) => messages.push(message),
      openBrowser: false
    });
    const handled = bridge.handle({
      jsonrpc: "2.0",
      id: "tool-1",
      method: "tools/call",
      params: {
        name: "get_problem_description",
        arguments: {}
      }
    });

    const poll = await relayFetch(
      relay,
      `/bridge/poll?sessionId=${encodeURIComponent(sessionId)}&timeout=1000`
    );
    const { requests } = await poll.json();
    await relayFetch(relay, "/bridge/respond", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sessionId,
        response: {
          jsonrpc: "2.0",
          id: requests[0].id,
          result: {
            content: [{ type: "text", text: "# Problem" }]
          }
        }
      })
    });
    await handled;

    assert.deepEqual(messages, [
      {
        jsonrpc: "2.0",
        id: "tool-1",
        result: {
          content: [{ type: "text", text: "# Problem" }]
        }
      }
    ]);
  });
});

test("exposes and forwards the complete MCP surface", async () => {
  await withRelay(async (relay) => {
    const messages = [];
    const opened = [];
    const bridge = new LocalMcpBridge({
      relay,
      send: (message) => messages.push(message),
      openBrowser: false,
      launch: async (url) => {
        opened.push(url);
        return true;
      }
    });

    for (const [id, method, params] of [
      ["initialize", "initialize", { protocolVersion: "2025-06-18" }],
      ["ping", "ping", undefined],
      ["tools", "tools/list", undefined],
      ["resources", "resources/list", undefined],
      [
        "status-disconnected",
        "tools/call",
        { name: "xpuoj_connection_status", arguments: {} }
      ],
      [
        "open",
        "tools/call",
        { name: "xpuoj_open_page", arguments: { url: "/p/1" } }
      ]
    ]) {
      await bridge.handle({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params })
      });
    }

    assert.deepEqual(opened, ["https://xpuoj.com/p/1"]);
    const toolList = messages.find(({ id }) => id === "tools").result.tools;
    assert.deepEqual(
      new Set(toolList.map(({ name }) => name)),
      new Set([
        "xpuoj_open_page",
        "xpuoj_connection_status",
        ...BROWSER_TOOLS.map(({ name }) => name)
      ])
    );
    assert.equal(
      toolList.find(({ name }) => name === "submit_code").annotations
        .destructiveHint,
      true
    );
    assert.match(
      messages.find(({ id }) => id === "status-disconnected").result.content[0]
        .text,
      /"connected": false/
    );

    const socket = new WebSocket(
      relay.baseUrl.replace("http:", "ws:") + "/bridge/ws",
      { origin: ORIGIN }
    );
    const hello = await nextWebSocketJson(socket);
    assert.equal(hello.type, "hello");

    await bridge.handle({
      jsonrpc: "2.0",
      id: "status-connected",
      method: "tools/call",
      params: { name: "xpuoj_connection_status", arguments: {} }
    });
    assert.match(
      messages.find(({ id }) => id === "status-connected").result.content[0]
        .text,
      /"connected": true/
    );

    for (const { name } of BROWSER_TOOLS) {
      const handled = bridge.handle({
        jsonrpc: "2.0",
        id: `tool-${name}`,
        method: "tools/call",
        params: {
          name,
          arguments: TOOL_ARGUMENTS[name]
        }
      });
      const request = await nextWebSocketJson(socket);
      assert.equal(request.method, "tools/call");
      assert.deepEqual(request.params, {
        name,
        arguments: TOOL_ARGUMENTS[name]
      });
      socket.send(
        JSON.stringify({
          type: "response",
          response: {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [{ type: "text", text: `ok:${name}` }]
            }
          }
        })
      );
      await handled;
      assert.equal(
        messages.find(({ id }) => id === `tool-${name}`).result.content[0]
          .text,
        `ok:${name}`
      );
    }

    const resourceHandled = bridge.handle({
      jsonrpc: "2.0",
      id: "resource-read",
      method: "resources/read",
      params: { uri: "problem://current" }
    });
    const resourceRequest = await nextWebSocketJson(socket);
    assert.equal(resourceRequest.method, "resources/read");
    assert.deepEqual(resourceRequest.params, { uri: "problem://current" });
    socket.send(
      JSON.stringify({
        type: "response",
        response: {
          jsonrpc: "2.0",
          id: resourceRequest.id,
          result: {
            contents: [
              {
                uri: "problem://current",
                mimeType: "application/json",
                text: "{}"
              }
            ]
          }
        }
      })
    );
    await resourceHandled;
    assert.equal(
      messages.find(({ id }) => id === "resource-read").result.contents[0].uri,
      "problem://current"
    );

    socket.close();
    await once(socket, "close");
  });
});
