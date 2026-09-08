# Issue #222 — Uncached `GET /models` on every `provideLanguageModelChatInformation` poll

**Status:** ✅ Solved (branch `fix/issues-216-223-batch`, commit `9f0eba9`)
**Topic:** models / caching / provider-poll
**Updated:** 2026-09-08
**Tags:** #models #cache #polling #logs
**GitHub Issue:** [ltmoerdani/opencode-copilot-chat#222](https://github.com/ltmoerdani/opencode-copilot-chat/issues/222)
**Related:** issue doc [35 (model list fetch resilience / #78)](35-20260720-issue78-model-list-fetch-resilience.md)

---

## Problem

Every UI refresh triggered a real upstream `GET /models` fetch plus a repeated
`Models registered` log line. The Output channel became noise; upstream saw
unbounded request volume from poll-happy clients.

## Analysis

`ModelListFetcher.fetch()` (`src/provider/modelList.ts`) performed the live
fetch unconditionally. `MODEL_LIST_CACHE_TTL_MS` existed but was only consulted
on the **failure** path (`loadCached()` inside `fallback()` and after the retry
loop). A successful fetch cached the snapshot, but the next `fetch()` never
looked at it. VS Code polls `provideLanguageModelChatInformation` every few
hundred ms, so each poll = live fetch + `replaceLiveModelMetadata` rebuild +
re-registration.

## Fix

- Cache-first reorder: `fetch()` consults the fresh snapshot
  (in-memory, then `globalState`, both TTL-guarded) **before** the network
  call; stale snapshots fall through to the existing fetch + retry path.
- `ModelListFetcher.invalidate()` clears both cache layers;
  `refreshMetadataAndModels()` (the `Refresh Models` command) calls it so a
  manual refresh still performs a real upstream fetch.
- `Models registered` summary in `src/provider/modelInfo.ts` is now logged
  only when its signature (count/first/last/variant) changes.

## Files Changed

| File                               | Change                                                    |
| ---------------------------------- | --------------------------------------------------------- |
| `src/provider/modelList.ts`        | cache-first `fetch()`, new `invalidate()`                 |
| `src/provider/modelInfo.ts`        | log-on-change via `LAST_REGISTRATION_LOG_SIGNATURE`       |
| `src/provider/OpenCodeProvider.ts` | `refreshMetadataAndModels()` calls `fetcher.invalidate()` |

## Verification

- `npx tsc --noEmit` clean; 454/454 unit tests pass; staged-lint gate pass.
- Follow-up (manual): confirm with the Output channel that repeated picker
  refreshes produce no new `Models registered` lines and no `/models` traffic
  within the TTL window.

## Lessons Learned

A TTL constant that only guards the failure path is not a cache — the
cache check has to sit before the work it is supposed to prevent.
