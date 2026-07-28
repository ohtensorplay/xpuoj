import assert from "node:assert/strict";
import test from "node:test";

import {
  describeTarget,
  getContestRanking,
  resolveContestId,
  resolveProblemTarget,
  safeError,
  summarizeContestRanking,
  summarizeSubmission,
  XpuojClient
} from "../dist/core.js";

test("resolves ordinary and contest targets", () => {
  assert.deepEqual(resolveProblemTarget({ target: "https://xpuoj.com/p/120" }), {
    kind: "ordinary",
    displayId: 120
  });
  assert.deepEqual(resolveProblemTarget({ target: "/p/1" }), {
    kind: "ordinary",
    displayId: 1
  });
  assert.deepEqual(
    resolveProblemTarget({
      target: "https://xpuoj.com/contest/7/problem/3"
    }),
    {
      kind: "contest",
      contestId: 7,
      problemOrder: 3
    }
  );
  assert.deepEqual(
    resolveProblemTarget({
      contestId: 5,
      problemOrder: 1
    }),
    {
      kind: "contest",
      contestId: 5,
      problemOrder: 1
    }
  );
});

test("rejects ambiguous targets", () => {
  assert.throws(
    () =>
      resolveProblemTarget({
        target: "1",
        problemId: 1
      }),
    /provide exactly one target/
  );
});

test("resolves contest IDs from IDs and XPUOJ URLs", () => {
  assert.equal(resolveContestId({ target: "7" }), 7);
  assert.equal(
    resolveContestId({ target: "https://xpuoj.com/contest/7/scoreboard?page=2" }),
    7
  );
  assert.equal(
    resolveContestId({ target: "https://xpuoj.com/contest/7/problem/3" }),
    7
  );
  assert.equal(resolveContestId({ contestId: 7 }), 7);
  assert.throws(
    () => resolveContestId({ target: "7", contestId: 7 }),
    /exactly one contest/
  );
});

test("uses public problem labels", () => {
  assert.equal(
    describeTarget({ kind: "ordinary", displayId: 120 }),
    "problem=/p/120"
  );
  assert.equal(
    describeTarget({ kind: "contest", contestId: 7, problemOrder: 3 }),
    "contest=7 problem=3"
  );
});

test("normalizes submission diagnostics", () => {
  const summary = summarizeSubmission({
    meta: {
      id: 73584,
      status: "Accepted",
      score: 100,
      displayScore: 76.33
    },
    progress: {
      progressType: "Finished",
      compile: {
        success: true,
        message: ""
      },
      testcaseResult: {
        abcdef: {
          status: "Accepted",
          time: 42,
          checkerMessage: "OK"
        }
      }
    }
  });
  assert.equal(summary.submissionId, 73584);
  assert.equal(summary.displayScore, 76.33);
  assert.equal(summary.testcases[0]?.checkerMessage, "OK");
});

test("normalizes ranking without exposing private entry fields", () => {
  const summary = summarizeContestRanking(
    7,
    {
      total: 2,
      scoreboard: [
        {
          rank: 1,
          userId: 9001,
          totalScore: 100,
          penalty: 42,
          userMeta: {
            username: "alice",
            nickname: "Alice\nOperator",
            email: "private@example.com"
          },
          problemScores: [{ order: 1, score: 100 }]
        }
      ]
    },
    {
      entry: {
        rank: 2,
        userId: 9002,
        totalScore: 96.25,
        userMeta: {
          username: "me"
        }
      }
    }
  );
  assert.deepEqual(summary.leaders, [
    {
      rank: 1,
      user: "Alice Operator",
      score: 100,
      penalty: 42
    }
  ]);
  assert.equal(summary.me?.rank, 2);
  assert.equal(summary.me?.penalty, null);
  assert.equal(summary.participated, true);
  assert.equal(JSON.stringify(summary).includes("private@example.com"), false);
  assert.equal(JSON.stringify(summary).includes("userId"), false);
  assert.equal(JSON.stringify(summary).includes("problemScores"), false);
});

test("loads the leading ranks and current user's rank", async () => {
  const requests = [];
  const client = new XpuojClient({
    apiBase: "https://example.invalid",
    token: "test-token",
    fetchFn: async (url, options) => {
      const endpoint = new URL(url).pathname;
      const payload = JSON.parse(options.body);
      requests.push({ endpoint, payload });
      if (endpoint.endsWith("/getContestScoreboardMe")) {
        return Response.json({
          entry: {
            rank: 8,
            totalScore: 88,
            userMeta: { username: "me" }
          }
        });
      }
      return Response.json({
        total: 20,
        scoreboard: [
          {
            rank: 1,
            totalScore: 100,
            userMeta: { username: "leader" }
          }
        ]
      });
    }
  });

  const ranking = await getContestRanking(client, 7, 5);
  assert.equal(ranking.total, 20);
  assert.equal(ranking.me?.rank, 8);
  assert.equal(ranking.leaders[0]?.user, "leader");
  assert.deepEqual(
    requests.map(({ endpoint }) => endpoint).sort(),
    [
      "/api/contest/play/getContestScoreboard",
      "/api/contest/play/getContestScoreboardMe"
    ]
  );
  assert.deepEqual(
    requests.find(({ endpoint }) => endpoint.endsWith("/getContestScoreboard"))
      ?.payload,
    {
      contestId: 7,
      skipCount: 0,
      takeCount: 5
    }
  );
});

test("does not rebind the fetch receiver to the XPUOJ client", async () => {
  let receiver;
  const client = new XpuojClient({
    apiBase: "https://example.invalid",
    token: "test-token",
    fetchFn: function () {
      receiver = this;
      return Promise.resolve(
        Response.json({
          meta: {
            id: 1,
            status: "Accepted"
          }
        })
      );
    }
  });
  await client.getSubmissionDetail(1);
  assert.equal(receiver, undefined);
});

test("still shows the user's rank when the full leaderboard is hidden", async () => {
  const client = new XpuojClient({
    apiBase: "https://example.invalid",
    token: "test-token",
    fetchFn: async (url) =>
      String(url).endsWith("/getContestScoreboardMe")
        ? Response.json({
            entry: {
              rank: 4,
              totalScore: 90,
              userMeta: { username: "me" }
            }
          })
        : Response.json({
            error: "PERMISSION_DENIED"
          })
  });
  const ranking = await getContestRanking(client, 7, 10);
  assert.equal(ranking.leaderboardAvailable, false);
  assert.equal(ranking.me?.rank, 4);
});

test("maps upstream permission failures without exposing the bearer token", async () => {
  const secret = "never-print-this-token";
  const client = new XpuojClient({
    apiBase: "https://example.invalid",
    token: secret,
    fetchFn: async () =>
      Response.json({
        error: {
          code: "PERMISSION_DENIED"
        }
      })
  });
  await assert.rejects(
    () => client.getSubmissionDetail(1),
    (error) => {
      assert.equal(error.code, "PERMISSION_DENIED");
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes("example.invalid"), false);
      assert.equal(error.message.includes("browser profile"), false);
      return true;
    }
  );
});

test("hides unexpected implementation errors from user output", () => {
  const safe = safeError(
    new Error("/private/session failed at https://internal.example/api")
  );
  assert.deepEqual(safe, {
    code: "OPERATION_FAILED",
    message: "The operation could not be completed. Please try again."
  });
});
