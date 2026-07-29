import assert from "node:assert/strict";
import test from "node:test";

import { DirectMcpBridge } from "../dist/mcp.js";

function call(bridge, id, name, arguments_ = {}) {
  return bridge.handle({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: arguments_ }
  });
}

test("exposes compact, prefix-free MCP tools", async () => {
  const messages = [];
  const bridge = new DirectMcpBridge({
    send: (message) => messages.push(message),
    history: {
      recordSubmitted() {},
      recordSubmissionDetail() {},
      recordSubmissionList() {},
      getOptimizationMemory() {
        return { target: null, attempts: 0, finished: 0, accepted: 0, best: null, recent: [] };
      },
      rememberReference() {
        return { id: 1, kind: "note", title: "note", summary: "note", sourceUrl: null, tags: [], updatedAt: 0 };
      },
      searchReferences() {
        return [];
      },
      recallForOptimization() {
        return { attempts: { target: null, attempts: 0, finished: 0, accepted: 0, best: null, recent: [] }, research: [] };
      },
      close() {}
    },
    createClient: async () => ({
      auth: { token: "hidden", source: "firefox" },
      client: {
        getCurrentUsername: async () => "me",
        getProblem: async (target) => ({
          meta: { target },
          localizedContentsOfLocale: {
            title: "P",
            contentSections: [{ sectionTitle: "题意", type: "text", text: "brief statement" }]
          },
          judgeInfo: { allowedSubmissionLanguages: ["cpp"] },
          samples: []
        }),
        getSubmissionDetail: async () => ({
          meta: { id: 1, status: "Accepted", score: 100, displayScore: 88 },
          content: { code: "int main() {}", language: "cpp" },
          progress: { progressType: "Finished", compile: { success: true }, testcaseResult: {} }
        }),
        listSubmissions: async () => ({
          username: "me",
          response: {
            submissions: [
              {
                id: 1,
                status: "Accepted",
                displayScore: 88,
                codeLanguage: "cpp",
                submitTime: "now",
                problem: { displayId: 1 },
                problemTitle: "P"
              }
            ],
            hasSmallerId: false
          }
        }),
        getContestScoreboard: async () => ({ scoreboard: [] }),
        getContestScoreboardMe: async () => ({ notParticipated: true }),
        submitSolution: async () => ({ submissionId: 9, target: { kind: "ordinary", displayId: 1 } })
      }
    })
  });

  await bridge.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await bridge.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await call(bridge, 3, "connection_status");
  await call(bridge, 4, "get_problem", { target: "/p/1" });
  await call(bridge, 5, "list_submissions");
  await call(bridge, 6, "get_submission", { submissionId: 1 });
  await call(bridge, 7, "get_submission_source", { submissionId: 1 });

  assert.equal(messages[0].result.serverInfo.name, "xpuoj-local-api");
  const names = messages[1].result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "connection_status",
    "get_problem",
    "get_ranking",
    "get_optimization_context",
    "plan_optimization_round",
    "distill_experience",
    "remember_research",
    "get_research_plan",
    "search_research",
    "export_memory",
    "import_memory",
    "list_submissions",
    "get_submission",
    "get_submission_source",
    "submit_solution"
  ]);
  assert.equal(names.some((name) => name.startsWith("xpuoj_")), false);
  assert.match(messages[2].result.content[0].text, /已连接 XPUOJ/);
  assert.match(messages[3].result.content[0].text, /提示：需完整题面/);
  assert.match(messages[4].result.content[0].text, /me 的提交记录/);
  assert.match(messages[5].result.content[0].text, /状态：Accepted/);
  assert.match(messages[6].result.content[0].text, /codeSha256/);
});

test("requires confirmation but computes the submitted code hash itself", async () => {
  const messages = [];
  const bridge = new DirectMcpBridge({
    send: (message) => messages.push(message),
    history: {
      recordSubmitted() {},
      recordSubmissionDetail() {},
      recordSubmissionList() {},
      getOptimizationMemory() {
        return { target: null, attempts: 0, finished: 0, accepted: 0, best: null, recent: [] };
      },
      rememberReference() {
        throw new Error("not reached");
      },
      searchReferences() {
        return [];
      },
      recallForOptimization() {
        return { attempts: { target: null, attempts: 0, finished: 0, accepted: 0, best: null, recent: [] }, research: [] };
      },
      close() {}
    },
    createClient: async () => {
      throw new Error("the guarded submission must not create a client");
    }
  });

  await call(bridge, 1, "submit_solution", {
    target: "/p/1",
    code: "int main() {}",
    language: "cpp",
    confirmExternalWrite: false
  });

  assert.match(messages[0].result.content[0].text, /confirmExternalWrite=true/);
  assert.doesNotMatch(messages[0].result.content[0].text, /expectedSha256/);
});
