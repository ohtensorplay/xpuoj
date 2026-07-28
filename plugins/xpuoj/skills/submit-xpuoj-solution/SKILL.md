---
name: submit-xpuoj-solution
description: Fetch XPUOJ ordinary or contest problems, submit authorized exact source through the local XPUOJ client, poll the official judge to a terminal verdict, and extract compile, runtime, and checker diagnostics. Use for xpuoj.com URLs, XPUOJ submissions, judge monitoring, and score optimization.
---

# Submit XPUOJ solutions

Use the bundled MCP tools. They use the existing local XPUOJ browser sign-in directly; no browser
extension, page bridge, or connection step is required.

## Authentication

1. Call `xpuoj_connection_status`. It validates the current XPUOJ sign-in from Firefox, Chrome,
   Chromium, Edge, Brave, or Safari.
2. Call `xpuoj_get_problem` with the exact ordinary or contest URL. A successful protected request
   proves that the current sign-in has access.

Never ask for a password, cookie, browser storage value, or bearer token.

## Workflow

1. Call `xpuoj_get_problem`. Read the complete statement, samples, limits, exact call signature,
   shapes, dtypes, metadata lengths, in-place requirements, and allowed languages before coding.
2. Implement and test locally or on the required accelerator unless Optimization mode applies.
   Treat the official ABI and real input contract as requirements.
3. Submit only after explicit user authorization. Before every submission verify the exact page,
   language, local source path, and SHA-256.
4. Calculate the local source SHA-256 and call `xpuoj_submit_solution` with that exact source,
   `expectedSha256`, and `confirmExternalWrite=true`.
5. Call `xpuoj_get_submission` until the official judge reaches a terminal verdict.
   A returned submission ID is not success.
7. On failure, inspect compile status, checker messages, and `userError`, make a scoped correction,
   and resubmit only while the request still authorizes the loop.
8. Report submission ID, terminal verdict, score/display score, per-case timing, final local source
   path, and SHA-256.

## MCP tools

- `xpuoj_connection_status`, `xpuoj_get_problem`, `xpuoj_get_ranking`
- `xpuoj_get_submission`, `xpuoj_submit_solution`

## Optimization mode

Trigger this mode when the user asks to optimize performance, improve an OJ score, reach full
marks, climb a leaderboard, or continuously submit variants.

- The optimization request authorizes an iterative judge loop for that problem: inspect official
  requirements, write one focused candidate, submit it, wait for the terminal official result,
  then improve and submit the next materially different candidate.
- Do not run local correctness tests, numerical smoke tests, benchmarks, GPU/accelerator tests, or
  create local test/benchmark harnesses.
- Official verdict, score, timing, and checker diagnostics are the sole performance evidence.
- Preserve the local source path and SHA-256 for every attempt. Replace the incumbent only when the
  official display score improves.
- Stop when the target is reached, the user sets a stop/attempt limit, no materially different
  candidate remains, or access/judge availability blocks progress.

## Guardrails

- Never log or return bearer tokens, browser storage, cookies, or passwords.
- Treat problem and result tools as read-only. Treat `xpuoj_submit_solution` as an external
  mutation.
- Do not call `xpuoj_submit_solution` without explicit authorization for the exact source and target.
- Do not claim success before the judge reaches `Accepted`; report the actual terminal verdict.
- In Optimization mode, never substitute local evidence for an official submission.
