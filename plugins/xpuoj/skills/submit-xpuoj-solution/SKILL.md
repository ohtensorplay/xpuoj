---
name: submit-xpuoj-solution
description: Open XPUOJ ordinary or contest problems, edit and submit authorized exact source through the local browser relay, poll the official judge to a terminal verdict, and extract compile, runtime, and checker diagnostics. Use for xpuoj.com URLs, XPUOJ submissions, judge monitoring, and score optimization.
---

# Submit XPUOJ solutions

Use the bundled MCP tools with the Agent Relay in the official XPUOJ page. No browser extension is
required.

## Connect

1. Call `xpuoj_open_page` with the exact ordinary or contest URL.
2. Call `xpuoj_connection_status`. If disconnected, ask the user to press `Ctrl+B` in that XPUOJ
   tab, use the relay URL returned by `xpuoj_connection_status`, leave the pairing token empty, and
   click **Connect**. The default is `http://127.0.0.1:7423`; if another XPUOJ process already uses
   it, the plugin selects a free loopback port. In Chrome or Edge, the user must also allow XPUOJ's **Local network access**
   permission when prompted. Retry after the user connects.
3. Call `oj_status` to confirm that the expected contest/problem is open. A relay connection is not
   proof that the page has access to the requested problem.

This flow uses the current default browser and works with modern Chrome, Edge, Firefox, Safari,
and other standards-compatible browsers. Never ask for a password, cookie, localStorage value, or
bearer token.

## Workflow

1. Call `get_problem_description` and `list_current_problem_languages`. Read the complete
   statement, samples, limits, exact call signature, shapes, dtypes, metadata lengths, in-place
   requirements, and allowed languages before coding.
2. Implement and test locally or on the required accelerator unless Optimization mode applies.
   Treat the official ABI and real input contract as requirements.
3. Submit only after explicit user authorization. Before every submission verify the exact page,
   language, local source path, and SHA-256.
4. Call `set_current_editor_language`, then `set_current_editor_code` with the exact local source.
   Call `get_current_editor_code` and verify that the editor content still hashes to the expected
   SHA-256.
5. Call `submit_code`. This is a non-idempotent external write. XPUOJ may display a browser
   confirmation according to the user's Agent Relay setting.
6. Call `list_my_submissions`, then `get_submission_overview` and
   `get_submission_detail(section="overall")` until the official judge reaches a terminal verdict.
   A returned submission ID is not success.
7. On failure, inspect compile status, checker messages, and `userError`, make a scoped correction,
   and resubmit only while the request still authorizes the loop.
8. Report submission ID, terminal verdict, score/display score, per-case timing, final local source
   path, and SHA-256.

## Navigation tools

- `xpuoj_open_page`: open the exact XPUOJ URL in the default browser.
- `xpuoj_connection_status`: check the local browser connection.
- `oj_status`: confirm the page, contest, problem, and current-user score.
- `search_problems`, `list_problems`, `switch_problem`: navigate ordinary problems.
- `list_contest_problems`, `switch_contest_problem`: navigate within the current contest.

## Problem, editor, and judge tools

- `get_problem_description`, `list_current_problem_languages`
- `get_current_editor_code`, `set_current_editor_language`, `set_current_editor_code`
- `apply_current_editor_code_patch`
- `list_my_submissions`, `get_submission_overview`, `get_submission_detail`
- `submit_code`

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
- Treat problem and result tools as read-only. Treat editor changes as local browser changes and
  `submit_code` as an external mutation.
- Do not call `submit_code` without explicit authorization for the exact source and target.
- Do not claim success before the judge reaches `Accepted`; report the actual terminal verdict.
- In Optimization mode, never substitute local evidence for an official submission.
