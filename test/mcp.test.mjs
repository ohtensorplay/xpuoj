import assert from "node:assert/strict";
import test from "node:test";

import { DirectMcpBridge } from "../dist/mcp.js";

test("serves XPUOJ problem tools without page bridging", async () => {
  const messages = [];
  const bridge = new DirectMcpBridge({
    send: (message) => messages.push(message),
    createClient: async () => ({
      auth: { token: "hidden", source: "firefox" },
      client: {
        getProblem: async (target) => ({ meta: { target }, localizedContentsOfLocale: { title: "P" } }),
        getSubmissionDetail: async () => ({ meta: { id: 1, status: "Accepted" }, progress: {} }),
        getContestScoreboard: async () => ({ scoreboard: [] }),
        getContestScoreboardMe: async () => ({ notParticipated: true }),
        submitSolution: async () => ({ submissionId: 9, target: { kind: "ordinary", displayId: 1 } })
      }
    })
  });

  await bridge.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await bridge.handle({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  await bridge.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "xpuoj_connection_status", arguments: {} }
  });
  await bridge.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "xpuoj_get_problem", arguments: { target: "/p/1" } }
  });

  assert.equal(messages[0].result.serverInfo.name, "xpuoj-local-api");
  assert.match(messages[1].result.content[0].text, /"source": "firefox"/);
  assert.match(messages[2].result.content[0].text, /"displayId": 1/);
});

test("requires explicit confirmation and a matching source hash before submission", async () => {
  const messages = [];
  const bridge = new DirectMcpBridge({
    send: (message) => messages.push(message),
    createClient: async () => {
      throw new Error("the guarded submission must not create a client");
    }
  });

  await bridge.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "xpuoj_submit_solution",
      arguments: {
        target: "/p/1",
        code: "int main() {}",
        language: "cpp",
        expectedSha256: "not-a-real-hash",
        confirmExternalWrite: false
      }
    }
  });

  assert.match(messages[0].result.content[0].text, /confirmExternalWrite=true/);
});
