# Issue #217 — gpt-5.6-luna consumes tokens but returns nothing ("empty-response loop")

**Status:** ✅ Solved (branch `fix/issues-216-223-batch`, commit `573f757`) — ⚠️ root-cause payload confirmed indirectly; keep the `[diag-sse-event-*]` path if a new shape appears
**Topic:** responses-api / zero-parts / diagnostics
**Updated:** 2026-09-08
**Tags:** #responses #luna #streaming #diagnostics
**GitHub Issue:** [ltmoerdani/opencode-copilot-chat#217](https://github.com/ltmoerdani/opencode-copilot-chat/issues/217)
**Related:** issue doc [86 (#197/#198 responses finish-reason + text extraction)](86-20260828-issue197-198-responses-api-finish-reason-text-extraction.md), issue doc [41 (luna routing)](41-20260803-gpt56-luna-routing-fix.md)

---

## Problem

OpenCode Go billed 146 completion tokens on gpt-5.6-luna but the chat showed
nothing, then VS Code surfaced "The request was stopped to prevent an
empty-response loop". Stack frames pointed at `engine.js` in our build.

## Analysis

Both strings in the reported error ("returned no usable response after
consuming N completion tokens", "prevent an empty-response loop") do **not**
exist anywhere in our source **or in the published 0.7.4 VSIX** (verified by
extracting the Marketplace package and grepping `out/`). The loop-guard wording
is Copilot Chat core reacting to a provider response that emitted zero chat
parts — i.e. our extractor produced nothing for a stream the gateway had
billed. This is the same failure class as #93 / #197 / #198: a new upstream
payload shape that the Responses event normalizer doesn't recognize.

Audit of `normalizeResponsesStreamEvent()` found a real gap:
`response.output_text.delta` only read **string-shaped** payloads
(`data.delta`, `data.text`). A nested shape (`delta: { text | content | value }`
or `text: { value }`) returned `{choices: []}` → zero parts for the whole
stream. Reasoning extraction had the same string-only assumption.

## Fix

- `response.output_text.delta` now unwraps nested payload objects before
  falling back to the flat fields.
- `extractResponsesReasoningText()` accepts nested `delta.text/thinking/summary`.
- After the bounded stream-failure retries are exhausted, a dedicated
  zero-part error names the token count, event/byte stats, and the
  `[diag-sse-event-*]` diagnostic path, so any future unhandled shape is
  reportable in one round-trip instead of surfacing as a generic loop guard.

## Files Changed

| File                       | Change                                                   |
| -------------------------- | -------------------------------------------------------- |
| `src/core/routing.ts`      | nested-payload support in text + reasoning normalization |
| `src/transports/engine.ts` | dedicated zero-parts-with-tokens error after retries     |

## Verification

- `npx tsc --noEmit` clean; 454/454 unit tests pass; staged-lint gate pass.
- Follow-up (manual): a luna session that previously hit the loop guard should
  now deliver content; if the gateway ships yet another shape, the new error
  message points reporters at the exact diag lines needed.

## Lessons Learned

"Zero parts + billed tokens" is always an extraction gap, never a model
refusal — treat the normalizer's fallback `{choices: []}` as the first
suspect, and make the failure message carry its own diagnostics.
