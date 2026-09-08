# Issue #216 — "No tool output found for function call call_…" (HTTP 400, gpt-5.6-luna)

**Status:** ✅ Solved (branch `fix/issues-216-223-batch`, commit `ed53ecb`)
**Topic:** responses-api / tool-call-pairing
**Updated:** 2026-09-08
**Tags:** #responses #tool-calls #pairing #luna
**GitHub Issue:** [ltmoerdani/opencode-copilot-chat#216](https://github.com/ltmoerdani/opencode-copilot-chat/issues/216)
**Related:** issue doc [90 (#206 fc_ item id normalization)](90-20260903-issue206-luna-responses-fc-id-mismatch.md), issue doc [68 (history trim)](68-20260820-history-trim-context-overflow.md)

---

## Problem

The request after a tool call failed with `Upstream request failed:
[invalid_request_error] No tool output found for function call call_RITWx…`
(HTTP 400) — the whole turn died even though VS Code had delivered the tool
result.

## Analysis

The #206 fix (commit `40be420`) normalized the `function_call` **item id** to
the `fc_` namespace while keeping `call_id` verbatim so it can pair with
`function_call_output.call_id`. Two residual gaps broke that pairing:

1. `responsesInputItemsFromMessage()` fabricated
   `call_id: \`tool-${Date.now()}\``for tool messages whose`tool_call_id`
   was lost — an id that can never match its call, so the gateway rejected
   the request.
2. History replay could deliver a `function_call` without its output (or vice
   versa) — e.g. after `trimOldMessagesToFitContext` dropped half a group, or
   when VS Code replayed tool messages in unusual shapes. The gateway rejects
   the entire request for a single unpaired item.

## Fix

- Never fabricate a `call_id`: a tool message without `tool_call_id` produces
  no `function_call_output` item.
- New pure `pairResponsesFunctionCallItems()` enforces strict 1:1 pairing over
  the assembled `input` list: orphaned outputs are dropped, calls without an
  output are dropped, duplicate outputs keep only the first. Wired into
  `buildResponsesRequestBody()`.
- Unit tests cover matched pairs, orphaned output, trimmed call, duplicate
  output, and the missing-`tool_call_id` case (`src/test/responsesRequest.test.ts`).

## Files Changed

| File                                | Change                                                     |
| ----------------------------------- | ---------------------------------------------------------- |
| `src/responsesRequest.ts`           | no fabricated call_id + `pairResponsesFunctionCallItems()` |
| `src/request/openai.ts`             | pairing pass in `buildResponsesRequestBody()`              |
| `src/test/responsesRequest.test.ts` | 5 regression tests                                         |

## Verification

- 454/454 unit tests pass (5 new); `npx tsc --noEmit` clean; staged-lint gate pass.
- Follow-up (manual): run a tool-calling agent turn on gpt-5.6-luna via
  `/v1/responses` and confirm the follow-up request no longer 400s.

## Lessons Learned

Fixing an id-format rejection (#206) without also enforcing the pairing
invariant left the adjacent failure mode one step away. Pairing should be a
post-condition of request assembly, not an emergent property of history.
