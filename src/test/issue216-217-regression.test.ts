import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/*
 * Regression tests for the issue batch #216 / #217, based on the REAL
 * gpt-5.6-luna event shapes captured in the Output channel during manual
 * verification (2026-09-08, /v1/responses tool-calling sessions).
 *
 * - #216 Test B: a long session that triggers history trim must still produce
 *   strictly paired function_call / function_call_output items (the gateway
 *   rejects the whole request otherwise).
 * - #217: the real luna event shapes must extract into usable parts (tool
 *   calls / text), including flat AND nested output_text.delta payloads.
 */

const vscodeMockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vscode-mock-216-")), "index.js");
fs.writeFileSync(
  vscodeMockPath,
  `"use strict";
class LanguageModelTextPart { constructor(value) { this.value = value; } }
class LanguageModelThinkingPart { constructor(text) { this.text = text; } }
class LanguageModelToolCallPart {
  constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; }
}
class LanguageModelToolResultPart { constructor(callId, content) { this.callId = callId; this.content = content; } }
module.exports = { LanguageModelTextPart, LanguageModelThinkingPart, LanguageModelToolCallPart, LanguageModelToolResultPart };
`,
  "utf-8",
);

type ResolveFilename = (request: string, parent: unknown, ...args: unknown[]) => string;
const moduleResolver = Module as unknown as { _resolveFilename: ResolveFilename };
const originalResolveFilename = moduleResolver._resolveFilename;
moduleResolver._resolveFilename = function (request: string, parent: unknown, ...args: unknown[]): string {
  if (request === "vscode") {
    return vscodeMockPath;
  }
  return originalResolveFilename.call(this, request, parent, ...args);
};

let OpenAiResponseExtractor: typeof import("../transports/extractors.js").OpenAiResponseExtractor;
let normalizeResponsesStreamEvent: typeof import("../core/routing.js").normalizeResponsesStreamEvent;
let trimOldMessagesToFitContext: typeof import("../provider/historyTrim.js").trimOldMessagesToFitContext;
let historyByteCapForBudget: typeof import("../provider/historyTrim.js").historyByteCapForBudget;
let pairResponsesFunctionCallItems: typeof import("../responsesRequest.js").pairResponsesFunctionCallItems;
let responsesInputItemsFromMessage: typeof import("../responsesRequest.js").responsesInputItemsFromMessage;

type ApiMessage = Record<string, unknown>;

/** Build a tool-call group (assistant tool_calls + tool result) as ApiMessages. */
function toolCallGroup(callId: string, fileName: string, resultChars: number): ApiMessage[] {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ filePath: fileName, startLine: 1, endLine: 240 }) },
        },
      ],
    },
    { role: "tool", tool_call_id: callId, content: "x".repeat(resultChars) },
  ];
}

/** Real luna event sequence for one tool call (trimmed to the discriminating shapes). */
function lunaToolCallEvents(callId: string, argsChunks: string[]): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    { type: "response.created", sequence_number: 0, response: { id: "resp_x", status: "in_progress", output: [], usage: null } },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: { id: "rs_1", type: "reasoning", encrypted_content: "gAAAA" },
    },
    {
      type: "response.output_item.done",
      sequence_number: 3,
      output_index: 0,
      item: { id: "rs_1", type: "reasoning", encrypted_content: "gAAAA" },
    },
    {
      type: "response.output_item.added",
      sequence_number: 4,
      output_index: 1,
      item: { id: "fc_1", type: "function_call", status: "in_progress", name: "read_file", call_id: callId, arguments: "" },
    },
  ];
  let seq = 5;
  for (const chunk of argsChunks) {
    events.push({ type: "response.function_call_arguments.delta", sequence_number: seq++, output_index: 1, item_id: "fc_1", delta: chunk });
  }
  events.push({
    type: "response.function_call_arguments.done",
    sequence_number: seq++,
    output_index: 1,
    item_id: "fc_1",
    arguments: argsChunks.join(""),
  });
  events.push({
    type: "response.output_item.done",
    sequence_number: seq++,
    output_index: 1,
    item: { id: "fc_1", type: "function_call", status: "completed", name: "read_file", call_id: callId, arguments: argsChunks.join("") },
  });
  events.push({
    type: "response.completed",
    sequence_number: seq++,
    response: { id: "resp_x", status: "completed", stop_reason: "tool_calls", usage: { input_tokens: 100, output_tokens: 50 } },
  });
  return events;
}

describe("#216 Test B: history trim keeps function_call pairing intact", () => {
  before(async () => {
    const responses = await import("../responsesRequest.js");
    pairResponsesFunctionCallItems = responses.pairResponsesFunctionCallItems;
    responsesInputItemsFromMessage = responses.responsesInputItemsFromMessage;
    const historyTrim = await import("../provider/historyTrim.js");
    trimOldMessagesToFitContext = historyTrim.trimOldMessagesToFitContext;
    historyByteCapForBudget = historyTrim.historyByteCapForBudget;
  });

  it("never leaves an unpaired function_call/function_call_output after trimming", () => {
    const messages: ApiMessage[] = [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Analyze the repository end to end." },
    ];
    for (let i = 0; i < 40; i++) {
      messages.push(...toolCallGroup(`call_${String(i).padStart(2, "0")}`, `/repo/file-${String(i)}.ts`, 4000));
      messages.push({ role: "user", content: `Continue the analysis (step ${String(i)}). ${"y".repeat(500)}` });
    }
    messages.push({ role: "user", content: "Final answer please." });

    const budget = 2000;
    // trimOldMessagesToFitContext mutates the array in place.
    const trimmed = trimOldMessagesToFitContext(messages as never, budget, historyByteCapForBudget(budget));
    assert.ok(trimmed.removed > 0, "expected history trim to remove messages");

    const items = pairResponsesFunctionCallItems(messages.flatMap((m) => responsesInputItemsFromMessage(m as never)));

    const callIds = items.filter((i) => i.type === "function_call").map((i) => i.call_id);
    const outputIds = items.filter((i) => i.type === "function_call_output").map((i) => i.call_id);
    assert.deepEqual(
      [...callIds].sort(),
      [...outputIds].sort(),
      "every surviving function_call must have exactly one matching function_call_output",
    );
    assert.ok(callIds.length > 0, "expected some paired tool calls to survive");
  });

  it("a tight-budget trimmed session also yields strictly paired items", () => {
    const messages: ApiMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      ...toolCallGroup("call_a", "a.ts", 3000),
      { role: "user", content: `more ${"z".repeat(4000)}` },
      ...toolCallGroup("call_b", "b.ts", 3000),
      { role: "user", content: "final" },
    ];
    const trimmed = trimOldMessagesToFitContext(messages as never, 500, historyByteCapForBudget(500));
    void trimmed;
    const items = pairResponsesFunctionCallItems(messages.flatMap((m) => responsesInputItemsFromMessage(m as never)));
    const calls = items.filter((i) => i.type === "function_call").map((i) => i.call_id);
    const outs = items.filter((i) => i.type === "function_call_output").map((i) => i.call_id);
    assert.deepEqual([...calls].sort(), [...outs].sort());
  });
});

describe("#217: luna Responses event shapes extract into parts", () => {
  before(async () => {
    const extractors = await import("../transports/extractors.js");
    OpenAiResponseExtractor = extractors.OpenAiResponseExtractor;
    const routing = await import("../core/routing.js");
    normalizeResponsesStreamEvent = routing.normalizeResponsesStreamEvent;
  });

  it("tool-call stream emits a complete tool call despite zero text", () => {
    const extractor = new OpenAiResponseExtractor(undefined, undefined, undefined, undefined, undefined, undefined, false);
    const events = lunaToolCallEvents("call_QijniLAwknJ2xoh0Ak3IQn9A", ['{"', "filePath", '":"', "/x.ts", '"}']);
    const parts: Array<{ name?: string; input?: unknown }> = [];
    for (const event of events) {
      for (const part of extractor.extractStreamParts(normalizeResponsesStreamEvent(event))) {
        parts.push(part as { name?: string; input?: unknown });
      }
    }
    // The response.completed event carries finish_reason, which is where the
    // extractor flushes accumulated tool calls.
    const tool = parts.find((p) => typeof p.name === "string");
    assert.ok(tool, "expected at least one usable part from a healthy luna tool-call stream");
    assert.equal(tool.name, "read_file");
    assert.deepEqual(tool.input, { filePath: "/x.ts" });
  });

  it("text stream emits text for flat and nested output_text.delta shapes", () => {
    const extractor = new OpenAiResponseExtractor(undefined, undefined, undefined, undefined, undefined, undefined, false);
    const events: Array<Record<string, unknown>> = [
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.output_text.delta", delta: { text: " nested" } },
      { type: "response.output_text.delta", text: { value: " world" } },
      {
        type: "response.completed",
        response: { id: "resp_y", status: "completed", stop_reason: "stop", usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ];
    let text = "";
    for (const event of events) {
      for (const part of extractor.extractStreamParts(normalizeResponsesStreamEvent(event))) {
        // LanguageModelTextPart carries the text in `value`.
        const asText = part as { value?: string; text?: string };
        if (typeof asText.value === "string") text += asText.value;
        else if (typeof asText.text === "string") text += asText.text;
      }
    }
    assert.match(text, /Hello/);
    assert.match(text, /nested/);
    assert.match(text, /world/);
  });
});
