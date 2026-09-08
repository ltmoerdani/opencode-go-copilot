import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installVscodeMock } from "./helpers/goUsageTestUtils.js";

/*
 * Gateway enforcement (docs/go, updated 2026-09-07): EVERY request to the
 * OpenCode gateway must carry a stable x-opencode-session. The main chat path
 * always did; these tests pin the auxiliary fetch sites that previously hit
 * the gateway without the header:
 *   - GET /models                (ModelListFetcher)
 *   - inline completions POST    (ChatCompletionEngine)
 *   - GET /usage                 (fetchGoUsage)
 */

installVscodeMock();

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(capture: CapturedRequest[], respond: () => Response): void {
  globalThis.fetch = ((input: unknown, init?: { headers?: Record<string, string> }) => {
    capture.push({
      url: String(input),
      headers: normalizeHeaders(init?.headers),
    });
    return Promise.resolve(respond());
  }) as unknown as typeof fetch;
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

function fakeContext(existing?: string): {
  globalState: { get(key: string): unknown; update(key: string, value: unknown): Thenable<void> };
} {
  const store = new Map<string, unknown>(existing ? [["opencode.auxSessionId", existing]] : []);
  return {
    globalState: {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      },
    },
  };
}

describe("x-opencode-session header on auxiliary gateway requests", () => {
  it("ModelListFetcher sends the session header on GET /models", async () => {
    const { ModelListFetcher } = await import("../provider/modelList.js");
    const capture: CapturedRequest[] = [];
    stubFetch(
      capture,
      () => new Response(JSON.stringify({ data: [{ id: "model-1" }] }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const fetcher = new ModelListFetcher({
      context: fakeContext() as never,
      definition: {
        vendor: "opencodego",
        displayName: "OpenCode Go",
        modelsUrl: "https://opencode.ai/zen/go/v1/models",
        fallbackModels: [],
      } as never,
      log: () => {},
      replaceLiveModelMetadata: () => {},
      filterAvailableModels: (ids: string[]) => Promise.resolve(ids),
    });
    const ids = await fetcher.fetch("sk-test");
    assert.deepEqual(ids, ["model-1"]);
    assert.equal(capture.length, 1);
    const session = capture[0].headers["x-opencode-session"];
    assert.ok(
      session && session.startsWith("vscode-aux-"),
      `expected auxiliary session header, got: ${JSON.stringify(capture[0].headers)}`,
    );
  });

  it("auxiliary session id is stable across calls and persisted in globalState", async () => {
    const { auxiliarySessionId } = await import("../request/headers.js");
    const context = fakeContext();
    const first = auxiliarySessionId(context as never);
    const second = auxiliarySessionId(context as never);
    assert.ok(first.startsWith("vscode-aux-"));
    assert.equal(first, second, "session id must be stable for the same installation state");
    assert.equal(context.globalState.get("opencode.auxSessionId"), first, "session id must be persisted to globalState");
    // A different installation (empty state) gets its own id.
    assert.notEqual(auxiliarySessionId(fakeContext() as never), first);
  });

  it("ChatCompletionEngine sends the session header on inline completions", async () => {
    const { ChatCompletionEngine } = await import("../autocomplete/engine.js");
    const capture: CapturedRequest[] = [];
    stubFetch(
      capture,
      () =>
        new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const engine = new ChatCompletionEngine({
      chatCompletionsUrl: "https://opencode.ai/zen/go/v1/chat/completions",
      apiKey: "sk-test",
      sessionId: "vscode-aux-test",
    });
    await engine.complete({ prefix: "const x = ", suffix: "", maxTokens: 64, modelId: "test-model" }, new AbortController().signal);
    assert.equal(capture.length, 1);
    assert.equal(capture[0].headers["x-opencode-session"], "vscode-aux-test");
  });

  it("fetchGoUsage sends the session header when a session id is supplied", async () => {
    const { fetchGoUsage } = await import("../usage/goUsageSync.js");
    const capture: CapturedRequest[] = [];
    stubFetch(capture, () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    await fetchGoUsage("sk-test", undefined, 1000, "https://opencode.ai/zen/go/v1/usage", "vscode-aux-usage");
    assert.equal(capture.length, 1);
    assert.equal(capture[0].headers["x-opencode-session"], "vscode-aux-usage");
  });
});
