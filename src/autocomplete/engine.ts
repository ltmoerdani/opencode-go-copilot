/**
 * Chat-completions completion engine (issue #49).
 *
 * Sends a tiny streamed chat-completions request to the OpenCode gateway and
 * collects the completion text. Uses the same endpoint and key as chat
 * requests; only `content` deltas are collected (with thinking forced off by
 * the prompt builder, no reasoning_content is expected).
 */

import { buildCompletionPrompt } from "./prompt";
import type { CompletionContext, CompletionEngine, CompletionResult } from "./types";
import { COMPLETION_REQUEST_TIMEOUT_MS } from "../config";

export { COMPLETION_REQUEST_TIMEOUT_MS } from "../config";

export interface ChatCompletionEngineOptions {
  /** Gateway chat-completions URL (provider-specific). */
  chatCompletionsUrl: string;
  apiKey: string;
  /** Stable session id for the gateway's x-opencode-session enforcement. */
  sessionId?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** Parse one SSE `data:` line into its JSON payload, if complete. */
export function parseSseData(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return undefined;
  const payload = trimmed.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") return undefined;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

/** Extract the text deltas from a stream chunk payload. */
export function extractChatCompletionText(data: unknown): { content: string; reasoning: string } {
  if (typeof data !== "object" || data === null) return { content: "", reasoning: "" };
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { content: "", reasoning: "" };
  const first = choices[0] as { delta?: { content?: unknown; reasoning_content?: unknown } } | undefined;
  const delta = first?.delta;
  if (!delta) return { content: "", reasoning: "" };
  return {
    content: typeof delta.content === "string" ? delta.content : "",
    reasoning: typeof delta.reasoning_content === "string" ? delta.reasoning_content : "",
  };
}

export class ChatCompletionEngine implements CompletionEngine {
  readonly id = "chat-completions";

  private readonly timeoutMs: number;
  private readonly log?: (msg: string) => void;

  constructor(private readonly options: ChatCompletionEngineOptions) {
    this.timeoutMs = options.timeoutMs ?? COMPLETION_REQUEST_TIMEOUT_MS;
    this.log = options.log;
  }

  async complete(ctx: CompletionContext, signal: AbortSignal): Promise<CompletionResult> {
    const started = Date.now();
    const prompt = buildCompletionPrompt(ctx.prefix, ctx.suffix, ctx.modelId);
    const body: Record<string, unknown> = {
      model: ctx.modelId,
      stream: true,
      max_tokens: ctx.maxTokens,
      messages: prompt.messages,
      ...prompt.extra,
    };

    let response: Response;
    try {
      response = await fetch(this.options.chatCompletionsUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          // Gateway enforcement (docs/go): all OpenCode requests need a
          // session id; completions share the persisted per-installation id.
          ...(this.options.sessionId ? { "x-opencode-session": this.options.sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log?.(`[completions] request failed: ${reason} (model=${ctx.modelId})`);
      // Network error or abort — treat as no completion.
      return { text: undefined, durationMs: Date.now() - started };
    }

    if (!response.ok || !response.body) {
      this.log?.(`[completions] non-OK response: HTTP ${String(response.status)} ${response.statusText} (model=${ctx.modelId})`);
      return { text: undefined, durationMs: Date.now() - started };
    }

    let collected = "";
    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          for (const line of event.split("\n")) {
            const data = parseSseData(line);
            if (data === undefined) continue;
            const { content } = extractChatCompletionText(data);
            if (content) {
              collected += content;
            }
          }
        }
      }
    } catch (error) {
      // Aborted or timed out mid-stream — keep what we have.
      const reason = error instanceof Error ? error.message : String(error);
      this.log?.(`[completions] stream interrupted: ${reason} (model=${ctx.modelId})`);
    }

    const text = cleanCompletion(collected);
    this.log?.(`[completions] ${this.id} model=${ctx.modelId} durationMs=${String(Date.now() - started)} textChars=${String(text.length)}`);
    return { text: text || undefined, durationMs: Date.now() - started };
  }
}

/**
 * Trim formatting noise from a raw completion. Fences are removed entirely;
 * trailing whitespace is trimmed. Leading spaces/tabs are stripped (the
 * cursor already sits on indented code, so a leading space would double it),
 * but leading NEWLINES are preserved — a completion that continues on a new
 * line (nested blocks) must keep its line break.
 */
export function cleanCompletion(raw: string): string {
  return raw
    .replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .replace(/^[ \t]+/, "")
    .replace(/\s+$/, "");
}
