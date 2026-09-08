**Status:** ✅ Solved

# Bundled Model Data Sync — models.dev Drift (Limits, Pricing, Fallback Catalog)

**Topic:** models / usage
**Updated:** 2026-09-08
**Tags:** #models #usage #metadata #models-dev #pricing
**Supersedes:** —

---

## Overview

A full audit of the bundled offline fallback data against the live models.dev
registry (`https://models.dev/api.json`, fetched 2026-09-08) found three
categories of drift: stale context limits, wrong static pricing, and a stale
Go fallback model catalog. All bundled data is only used when the live
models.dev fetch and the gateway `/models` endpoint are unavailable, but the
wrong values were large enough to matter (up to 6x cost under-reporting).

---

## Problem

### 1. Context-limit drift in `MODEL_LIMITS_BY_PROVIDER` (Go)

| Model            | Bundled | models.dev now | Provenance of the old value                                                     |
| ---------------- | ------- | -------------- | ------------------------------------------------------------------------------- |
| `kimi-k2.7-code` | 256,000 | **262,144**    | Verified against models.dev on 2026-06-15 (issue #25); models.dev changed since |
| `minimax-m3`     | 512,000 | **1,000,000**  | 2026-06-09 snapshot; Zen still lists 512K, Go was raised to 1M                  |
| `qwen3.6-plus`   | 262,144 | **1,000,000**  | 2026-05 era value; Zen still lists 262K, Go raised to 1M                        |
| `qwen3.7-plus`   | 262,144 | **1,000,000**  | Copy-paste from `qwen3.6-plus` in commit `1c26fd1` (2026-08-13), never verified |

Key evidence: models.dev now differentiates Go vs Zen per model
(`minimax-m3` Go 1M / Zen 512K; `qwen3.6-plus` Go 1M / Zen 262K). The bundled
Go values exactly matched the **Zen** values — the same cross-provider
contamination pattern fixed in `docs/issues/02-20260516-context-size-correction.md`.

**Deliberate deviations kept (NOT synced):**

- `deepseek-v4-flash` output 131,072 — gateway completion cap (#171, `docs/issues/71-20260821-issue171-go-completion-cap-retry.md`).
- `minimax-m2.5` (Go) output 65,536 — deliberate reduction documented in CHANGELOG.

### 2. Wrong static pricing in `src/usage/pricing.ts`

The last-resort `GO_MODEL_PRICING` table had drifted badly from models.dev:

| Model               | Bundled                          | Actual (models.dev)              | Impact                 |
| ------------------- | -------------------------------- | -------------------------------- | ---------------------- |
| `mimo-v2.5-pro`     | $1.74 / $3.48                    | **$0.435 / $0.87**               | 4x over-report         |
| `deepseek-v4-pro`   | $1.74 / $3.48                    | **$0.66 / $1.98**                | ~2.6x over-report      |
| `deepseek-v4-flash` | $0.14 / $0.28                    | **$0.22 / $0.66**                | under-report           |
| `mimo-v2-omni`      | $0.14 / $0.28                    | **$0.40 / $2.00**                | big under-report       |
| `minimax-m3`        | $0.60 / $2.40                    | **$0.30 / $1.20**                | 2x over-report         |
| `kimi-k3`           | _(missing → $0.5/$2.0 fallback)_ | **$3.00 / $15.00**               | **6x under-report**    |
| `hy3-preview`       | $0.50 / $1.50                    | renamed `hy3`: **$0.14 / $0.58** | stale id + wrong price |

Also removed: `minimax-m2.1`, `minimax-m2` (no longer served by the gateway).
Added all 15 new Go models (glm-5.2/5.3/5.3-flash, qwen3.8-max/flash,
grok-4.5/4.6, kimi-k3, hy3, hy4-preview, omen-alpha, longcat-2.0,
ox-alpha-free, muse-spark-1.3-contributor, deepseek-v4-flash-vision-exp,
gpt-5.6-luna).

### 3. Stale Go fallback catalog in `src/provider/definitions.ts`

`fallbackModels` still listed `hy3-preview` (renamed to `hy3` upstream),
omitted `kimi-k2.7-code` and every model added after June, and included
deprecated models — contradicting the README's promise that deprecated/legacy
models are filtered. Refreshed to the 27-model curated active set
(8 upstream-deprecated models removed).

### 4. Stale tests referencing `hy3-preview`

`metadata.test.ts`, `registry.test.ts`, `thinking.test.ts` still referenced
the retired `hy3-preview` id (passing only because the catch-all routing made
both ids behave identically). Updated to `hy3`.

---

## Fix

| File                                                     | Change                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/models/modelTables.ts`                              | 4 context limits synced; `kimi-k2.7-code` 256K → 262,144                                                        |
| `src/usage/pricing.ts`                                   | Full table rewrite from models.dev (2026-09-08); 6 wrong prices fixed, 15 models added, 3 stale entries removed |
| `src/provider/definitions.ts`                            | Go `fallbackModels` refreshed to curated active set                                                             |
| `src/test/metadata.test.ts`                              | kimi-k2.7-code lock 256,000 → 262,144; `hy3-preview` → `hy3`                                                    |
| `src/test/registry.test.ts`, `src/test/thinking.test.ts` | `hy3-preview` → `hy3`                                                                                           |
| `src/test/goUsageTracker.test.ts`                        | deepseek-v4-flash bundled-pricing expectation updated to new values                                             |

---

## Verification

- `npm run lint` — all 7 checks pass (462 tests, 0 fail).
- models.dev snapshot diffed programmatically before/after (curl + python3).

## Caveats

- Bundled values are offline fallbacks only; the live models.dev fetch
  (`metadataFetcher.ts`) remains the primary source and overrides them.
- The raised context limits (1M for minimax-m3 / qwen3.6-plus / qwen3.7-plus)
  were not verified against the live gateway with a real oversized request —
  models.dev is OpenCode's own registry and now differentiates Go vs Zen, but
  the #171 precedent (models.dev output values overstated) shows the gateway
  can lag. If a user reports context truncation on these models, re-verify.
- `DEFAULT_INLINE_MODEL` is still `qwen3.5-plus`, which is upstream-deprecated.
  Flagged for follow-up; not changed here.
