# Issue #220 — Dozens of duplicate "OpenCode" output channels accumulate per session

**Status:** ✅ Solved (branch `fix/issues-216-223-batch`, commit `5d2b525`)
**Topic:** output-channel / lifecycle
**Updated:** 2026-09-08
**Tags:** #output-channel #regression #refactor-fallout
**GitHub Issue:** [ltmoerdani/opencode-copilot-chat#220](https://github.com/ltmoerdani/opencode-copilot-chat/issues/220)
**Related:** PR #155 god-file split (doc 67), PR #138 central config refactor (doc 66)

---

## Problem

Every chat request registered a brand-new `OpenCode` entry in the Output-tab
dropdown. Long sessions accumulated dozens of channels and the machine slowed
down; disabling the extension stopped the growth (reporter's A/B test).

## Analysis

`vscode.window.createOutputChannel()` registers a NEW channel every call —
there is no dedup by name. `OpenCodeProvider.getOutputChannel()` already used
the correct lazy-singleton pattern, but the god-file split
(`03029a6` / `e8fb6b2`) copied a `createOutputChannel("OpenCode")` call into
`prepareChatRequest()` (`src/provider/chatPrep.ts`), which runs **per request**.
Each request therefore leaked one more channel.

## Fix

- Removed the per-request channel creation (and the `outputChannel` field)
  from `chatPrep.ts`.
- `OpenCodeProvider.provideLanguageModelChatResponse()` now passes its shared
  lazy-singleton channel (already pushed to `context.subscriptions`, so it is
  disposed with the extension) to all four transports.

## Files Changed

| File                               | Change                                             |
| ---------------------------------- | -------------------------------------------------- |
| `src/provider/chatPrep.ts`         | drop `createOutputChannel` + `outputChannel` field |
| `src/provider/OpenCodeProvider.ts` | use `this.getOutputChannel()` for transports       |

## Verification

- `npx tsc --noEmit` clean; 454/454 unit tests pass; staged-lint gate pass.
- Follow-up (manual): keep a session open through multiple requests and verify
  exactly one `OpenCode` entry exists in the Output dropdown.

## Lessons Learned

`createOutputChannel` is a register operation, not a lookup — any call that
isn't behind a singleton guard will multiply UI entries.
