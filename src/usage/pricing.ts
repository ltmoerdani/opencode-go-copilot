import type { ModelCost } from "../models/metadata";

/** Callback to resolve live model cost from the models.dev metadata cache. */
export type CostResolver = (modelId: string) => ModelCost | undefined;

// ─── Go model pricing ($/1M tokens) — bundled snapshot fallback ────────────
// This table is a static snapshot kept as a last resort. The primary source
// is the live models.dev metadata cache injected via CostResolver.

/**
 * Conservative per-1M-token fallback for Go models absent from the bundled
 * snapshot (e.g. a brand-new release) when the live models.dev resolver is
 * also unavailable. Better a plausible estimate than a silent $0 (which reads
 * as "free"). Replaced by the authoritative price as soon as a snapshot lands.
 */
const UNKNOWN_GO_MODEL_PRICE: ModelCost = { input: 0.5, output: 2.0, cache_read: 0.05 };

const GO_MODEL_PRICING: Record<string, ModelCost | undefined> = {
  // Synced from models.dev opencode-go snapshot (2026-09-08). The live
  // CostResolver remains the primary source; this table only covers offline.
  "deepseek-v4-flash": { input: 0.22, output: 0.66, cache_read: 0.007 },
  "deepseek-v4-flash-vision-exp": { input: 0.22, output: 0.66, cache_read: 0.007 },
  "deepseek-v4-pro": { input: 0.66, output: 1.98, cache_read: 0.022 },
  "glm-5": { input: 1.0, output: 3.2, cache_read: 0.2 },
  "glm-5.1": { input: 1.4, output: 4.4, cache_read: 0.26 },
  "glm-5.2": { input: 1.4, output: 4.4, cache_read: 0.26 },
  "glm-5.3": { input: 1.4, output: 4.4, cache_read: 0.26 },
  // Official docs (opencode.ai/docs/go/#usage-limits, Sep 2026) list
  // $0.15/$0.50 with cache $0.03 — models.dev had half that value.
  "glm-5.3-flash": { input: 0.15, output: 0.5, cache_read: 0.03 },
  "grok-4.5": { input: 2.0, output: 6.0, cache_read: 0.3 },
  "grok-4.6": { input: 2.0, output: 6.0, cache_read: 0.5 },
  hy3: { input: 0.14, output: 0.58, cache_read: 0.035 },
  "hy4-preview": { input: 0.834, output: 2.501, cache_read: 0.042 },
  "kimi-k2.5": { input: 0.6, output: 3.0, cache_read: 0.1 },
  "kimi-k2.6": { input: 0.95, output: 4.0, cache_read: 0.16 },
  "kimi-k2.7-code": { input: 0.95, output: 4.0, cache_read: 0.19 },
  "kimi-k3": { input: 3.0, output: 15.0, cache_read: 0.3 },
  "longcat-2.0": { input: 0.3, output: 1.2, cache_read: 0.006 },
  "minimax-m2.5": { input: 0.3, output: 1.2, cache_read: 0.03 },
  "minimax-m2.7": { input: 0.3, output: 1.2, cache_read: 0.06 },
  "minimax-m3": { input: 0.3, output: 1.2, cache_read: 0.06 },
  "mimo-v2.5": { input: 0.14, output: 0.28, cache_read: 0.0028 },
  "mimo-v2.5-pro": { input: 0.435, output: 0.87, cache_read: 0.003625 },
  "mimo-v2-omni": { input: 0.4, output: 2.0, cache_read: 0.08 },
  "mimo-v2-pro": { input: 1.0, output: 3.0, cache_read: 0.2 },
  "muse-spark-1.2-contributor": { input: 0.1, output: 0.2, cache_read: 0.002 },
  "muse-spark-1.3-contributor": { input: 0.1, output: 0.2, cache_read: 0.002 },
  "omen-alpha": { input: 0.2, output: 0.66, cache_read: 0.04 },
  "ox-alpha-free": { input: 0, output: 0 },
  "qwen3.5-plus": { input: 0.2, output: 1.2, cache_read: 0.02 },
  "qwen3.6-plus": { input: 0.5, output: 3.0, cache_read: 0.05 },
  "qwen3.7-max": { input: 2.5, output: 7.5, cache_read: 0.5 },
  "qwen3.7-plus": { input: 0.4, output: 1.6, cache_read: 0.04 },
  "qwen3.8-flash": { input: 0.15, output: 0.47, cache_read: 0.016 },
  "qwen3.8-max": { input: 2.0, output: 6.0, cache_read: 0.25 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cache_read: 0.02 },
};

// ─── Cost calculation ────────────────────────────────────────────────────────

/** Priority: caller-provided cost > live models.dev snapshot > bundled table */
export function estimateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  externalCost?: ModelCost,
  liveCostResolver?: CostResolver,
): number {
  // Priority: caller-provided cost > live models.dev snapshot > bundled table > conservative fallback
  const pricing = externalCost ?? liveCostResolver?.(modelId) ?? GO_MODEL_PRICING[modelId] ?? UNKNOWN_GO_MODEL_PRICE;

  const billablePrompt = Math.max(0, promptTokens - cachedTokens);
  return (
    (billablePrompt * pricing.input) / 1_000_000 +
    (completionTokens * pricing.output) / 1_000_000 +
    (cachedTokens * (pricing.cache_read ?? pricing.input * 0.1)) / 1_000_000
  );
}
