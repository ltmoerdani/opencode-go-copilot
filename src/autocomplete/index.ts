/**
 * Inline completions registration (issue #49).
 *
 * Wires the completion engine + provider into the extension. The provider
 * checks the opt-in configuration live, resolves the API key per request,
 * and the engine is created with that key (cheap). Register once; toggling
 * `opencodego.inlineSuggestions` is honored on the fly.
 */

import * as vscode from "vscode";
import { ChatCompletionEngine } from "./engine";
import { OpenCodeInlineCompletionProvider } from "./provider";
import type { CompletionContext, CompletionEngine, CompletionResult } from "./types";
import {
  COMPLETION_USAGE_KEY,
  COMPLETION_USAGE_MAX_DAYS,
  CONFIG_SECTION,
  DEFAULT_INLINE_SUGGESTIONS_CHAT_INPUT,
  DEFAULT_INLINE_DEBOUNCE_MS,
  DEFAULT_INLINE_MAX_TOKENS,
  DEFAULT_INLINE_MODEL,
  DEFAULT_INLINE_PREFIX_LINES,
  DEFAULT_INLINE_SUFFIX_CHARS,
  DEFAULT_INLINE_TIMEOUT_MS,
  INLINE_DEBOUNCE_MS_SETTING,
  INLINE_MAX_TOKENS_SETTING,
  INLINE_PREFIX_LINES_SETTING,
  INLINE_SUGGESTIONS_MODEL_SETTING,
  INLINE_SUGGESTIONS_SETTING,
  INLINE_SUFFIX_CHARS_SETTING,
  INLINE_TIMEOUT_MS_SETTING,
  SETTING_INLINE_SUGGESTIONS_CHAT_INPUT,
} from "../config";
import { toFiniteNumber } from "../utils";
import { auxiliarySessionId } from "../request/headers";
import { bumpCompletionUsage, matchesAcceptance, utcDayStart, type CompletionUsageDay } from "./usage";

export {
  INLINE_SUGGESTIONS_SETTING,
  INLINE_SUGGESTIONS_MODEL_SETTING,
  INLINE_DEBOUNCE_MS_SETTING,
  INLINE_TIMEOUT_MS_SETTING,
  INLINE_MAX_TOKENS_SETTING,
  INLINE_PREFIX_LINES_SETTING,
  INLINE_SUFFIX_CHARS_SETTING,
  DEFAULT_INLINE_MODEL,
  DEFAULT_INLINE_DEBOUNCE_MS,
  DEFAULT_INLINE_TIMEOUT_MS,
  DEFAULT_INLINE_MAX_TOKENS,
  DEFAULT_INLINE_PREFIX_LINES,
  DEFAULT_INLINE_SUFFIX_CHARS,
} from "../config";

export interface InlineCompletionsDeps {
  /** Gateway chat-completions URL (Go). */
  chatCompletionsUrl: string;
  /** Resolve the API key to use (extension secret / BYOK group key). */
  resolveApiKey: () => Promise<string | undefined>;
  /** Day boundary for the completion counters (defaults to UTC). */
  resolveCompletionDayStart?: () => number;
  log?: (msg: string) => void;
}

function readSetting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<T>(key, fallback);
}

/** Read a numeric setting, clamped to a sane range (guards against bad config values). */
function readNumberSetting(key: string, fallback: number, min: number, max: number): number {
  return toFiniteNumber(readSetting(key, fallback), fallback, min, max);
}

export function registerInlineCompletions(context: vscode.ExtensionContext, deps: InlineCompletionsDeps): vscode.Disposable {
  const output = vscode.window.createOutputChannel("OpenCode Completions");
  context.subscriptions.push(output);
  const log = (msg: string): void => {
    output.appendLine(msg);
  };

  // Per-day suggestion/acceptance counters for the usage panel charts.
  let completionUsage = context.globalState.get<CompletionUsageDay[]>(COMPLETION_USAGE_KEY, []);
  const dayStart = (): number => deps.resolveCompletionDayStart?.() ?? utcDayStart(Date.now());
  const recordCompletion = (kind: "suggested" | "approved"): void => {
    completionUsage = bumpCompletionUsage(completionUsage, dayStart(), kind, COMPLETION_USAGE_MAX_DAYS);
    void context.globalState.update(COMPLETION_USAGE_KEY, completionUsage);
  };

  // Acceptance tracking: VS Code's stable API exposes NO acceptance event
  // for inline completions, so we detect the insert that committing a ghost
  // text produces: it starts exactly at the suggested position and matches
  // the suggested text. The pending suggestion expires after 30s and is
  // cleared on the first match, bounding false positives.
  const ACCEPTANCE_WINDOW_MS = 30_000;
  let pendingSuggestion: { documentUri: string; position: vscode.Position; text: string; expiresAt: number } | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!pendingSuggestion) return;
      if (Date.now() > pendingSuggestion.expiresAt) {
        pendingSuggestion = undefined;
        return;
      }
      if (event.document.uri.toString() !== pendingSuggestion.documentUri) return;
      for (const change of event.contentChanges) {
        if (change.range.start.isEqual(pendingSuggestion.position) && matchesAcceptance(change.text, pendingSuggestion.text)) {
          recordCompletion("approved");
          pendingSuggestion = undefined;
          return;
        }
      }
    }),
  );

  const engine: CompletionEngine = {
    id: "chat-completions",
    async complete(ctx: CompletionContext, signal: AbortSignal): Promise<CompletionResult> {
      const apiKey = await deps.resolveApiKey();
      if (!apiKey) {
        log("[completions] no API key — skipping");
        return { text: undefined, durationMs: 0 };
      }
      log(`[completions] model=${ctx.modelId} prefixChars=${String(ctx.prefix.length)} suffixChars=${String(ctx.suffix.length)}`);
      const keyed = new ChatCompletionEngine({
        chatCompletionsUrl: deps.chatCompletionsUrl,
        apiKey,
        sessionId: auxiliarySessionId(context),
        timeoutMs: readNumberSetting(INLINE_TIMEOUT_MS_SETTING, DEFAULT_INLINE_TIMEOUT_MS, 500, 15_000),
        log: (msg) => {
          log(msg);
        },
      });
      return keyed.complete(ctx, signal);
    },
  };

  const provider = new OpenCodeInlineCompletionProvider({
    engine,
    resolveApiKey: deps.resolveApiKey,
    onSuggestion: (text, position, document) => {
      recordCompletion("suggested");
      pendingSuggestion = {
        documentUri: document.uri.toString(),
        position,
        text,
        expiresAt: Date.now() + ACCEPTANCE_WINDOW_MS,
      };
    },
    isEnabled: () => readSetting(INLINE_SUGGESTIONS_SETTING, false),
    resolveModelId: () => readSetting(INLINE_SUGGESTIONS_MODEL_SETTING, DEFAULT_INLINE_MODEL),
    resolveDebounceMs: () => readNumberSetting(INLINE_DEBOUNCE_MS_SETTING, DEFAULT_INLINE_DEBOUNCE_MS, 50, 2_000),
    resolveMaxTokens: () => readNumberSetting(INLINE_MAX_TOKENS_SETTING, DEFAULT_INLINE_MAX_TOKENS, 16, 1_024),
    resolvePrefixLines: () => readNumberSetting(INLINE_PREFIX_LINES_SETTING, DEFAULT_INLINE_PREFIX_LINES, 1, 100),
    resolveSuffixChars: () => readNumberSetting(INLINE_SUFFIX_CHARS_SETTING, DEFAULT_INLINE_SUFFIX_CHARS, 0, 5_000),
    resolveChatInputEnabled: () => readSetting(SETTING_INLINE_SUGGESTIONS_CHAT_INPUT, DEFAULT_INLINE_SUGGESTIONS_CHAT_INPUT),
  });

  const registration = vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider);
  context.subscriptions.push(registration, provider);
  return registration;
}
