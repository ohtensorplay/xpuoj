---
name: submit-xpuoj-solution
description: Fetch XPUOJ ordinary or contest problems, submit authorized exact source through the local XPUOJ client, poll the official judge to a terminal verdict, and extract compile, runtime, and checker diagnostics. Use for xpuoj.com URLs, XPUOJ submissions, judge monitoring, and score optimization.
---

# Submit XPUOJ solutions

Use the bundled MCP tools. They use the existing local XPUOJ browser sign-in directly; no browser
extension, page bridge, or connection step is required.

## CLI availability

The MCP server starts through `npx`, so a global `xpuoj` command may not exist. Before a workflow
needs that command, run `bash scripts/ensure-xpuoj-cli.sh` from this skill directory. It checks for
`xpuoj`, installs `@tensorplay/xpuoj@latest` globally only when missing, and verifies the result.
Do not reinstall it when the command already exists. `xpuoj update` checks for a newer release; it
does not reinstall the CLI.

## Authentication

1. Call `connection_status`. It validates the current XPUOJ sign-in from Firefox, Chrome,
   Chromium, Edge, Brave, or Safari.
2. Call `get_problem` with the exact ordinary or contest URL. A successful protected request
   proves that the current sign-in has access.

Never ask for a password, cookie, browser storage value, or bearer token.

## Workflow

1. Call `get_problem` with `includeStatement=true`. Read the complete statement, samples, limits, exact call signature,
   shapes, dtypes, metadata lengths, in-place requirements, and allowed languages before coding.
2. Implement and test locally or on the required accelerator unless Optimization mode applies.
   Treat the official ABI and real input contract as requirements.
3. Submit only after explicit user authorization. Before every submission verify the exact page,
   language, local source path, and SHA-256.
4. Call `submit_solution` with the exact source and `confirmExternalWrite=true`. It returns the
   SHA-256 of the exact code it sent; do not ask the caller to precompute a hash.
5. Call `get_submission` until the official judge reaches a terminal verdict.
   A returned submission ID is not success.
7. On failure, inspect compile status, checker messages, and `userError`, make a scoped correction,
   and resubmit only while the request still authorizes the loop.
8. Report submission ID, terminal verdict, score/display score, per-case timing, final local source
   path, and SHA-256.

## MCP tools

- `connection_status`, `get_problem`, `get_ranking`
- `list_submissions`, `get_submission`, `get_submission_source`, `submit_solution`
- `get_optimization_context`, `plan_optimization_round`, `distill_experience`
- `get_research_plan`, `remember_research`, `search_research`
- `export_memory`, `import_memory`

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

### Evidence-driven loop

Before an optimization round, call `get_optimization_context` and `get_research_plan` with the exact
operator and target hardware. Research sources in this order:

1. Vendor architecture, ISA, compiler, profiler, and release-note documentation.
2. Original paper, upstream implementation, and maintained benchmark.
3. Developer forums, GitHub issues, and reproducible community artifacts as leads; verify them against
   a primary source or an official XPUOJ result before relying on them.

Store concise, source-attributed findings with `remember_research`. Then call
`plan_optimization_round` with one falsifiable hypothesis and one coherent change. Pass its `roundId`
to `submit_solution`. After the official terminal verdict, call `get_submission`; it records the
outcome. Use `distill_experience` only with terminal official rounds, and supersede a previous lesson
when later evidence contradicts it.

The local SQLite memory records only work actually performed through this MCP: no automatic external
history backfill. `export_memory` creates a portable `xpuoj-memory/sqlite-v1` binary for another CLI;
`import_memory` merges one without deleting existing memory.

## Guardrails

- Never log or return bearer tokens, browser storage, cookies, or passwords.
- `get_submission_source` returns code; call it only when source is required.
- Treat problem and result tools as read-only. Treat `submit_solution` as an external
  mutation.
- Do not call `submit_solution` without explicit authorization for the exact source and target.
- Do not claim success before the judge reaches `Accepted`; report the actual terminal verdict.
- In Optimization mode, never substitute local evidence for an official submission.
