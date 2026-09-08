import Module from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type { ModelCost } from "../../models/metadata.js";
import type { TransportRequestSummary } from "../../core/transport.js";
import type { UsageSummary } from "../../usage/tracker.js";

/**
 * Shared fixtures for the goUsageTracker test files: instance types, mock
 * SecretStorage/globalState factories and the "vscode" module stub that lets
 * the tracker import cleanly under the unit-test runner.
 */

export interface SessionSummary {
  sessionId: string;
  cost: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  lastActivity: number;
}

export interface GoUsageTrackerInstance {
  record(summary: TransportRequestSummary, externalCost?: ModelCost): void;
  getCurrentSessionCost(): SessionSummary | undefined;
  getRecentSessionCosts(limit?: number): SessionSummary[];
  getSummary(): UsageSummary;
  readonly hasServerUsage: boolean;
  clear(): void;
}

export type GoUsageTrackerConstructor = new (
  context: unknown,
  log?: (msg: string) => void,
  costResolver?: (modelId: string) => ModelCost | undefined,
  storageKeySuffix?: string,
) => GoUsageTrackerInstance;

// ── Mock helpers ───────────────────────────────────────────────────────────

export function createMockStore(initial: Record<string, unknown> = {}) {
  const _data = new Map(Object.entries(initial));
  return {
    _data,
    get: <T>(key: string, defaultVal: T): T => (_data.has(key) ? (_data.get(key) as T) : defaultVal),
    update: (key: string, value: unknown): Promise<void> => {
      _data.set(key, value);
      return Promise.resolve();
    },
  };
}

export function createMockContext(initial: Record<string, unknown> = {}) {
  return {
    globalState: createMockStore(initial),
    subscriptions: [],
  };
}

export function makeSummary(overrides: Partial<TransportRequestSummary> = {}): TransportRequestSummary {
  return {
    providerDisplayName: "OpenCode Go",
    modelId: "qwen3.6-plus",
    url: "https://api.opencode.ai/v1/chat/completions",
    payloadBytes: 500,
    totalBytes: 2000,
    totalEvents: 1,
    durationMs: 800,
    promptTokens: 100,
    completionTokens: 50,
    cachedTokens: 10,
    sessionId: "test-session",
    ...overrides,
  };
}

let vscodeMockInstalled = false;

/** Install the "vscode" stub once per process; safe to call from every test file. */
export function installVscodeMock(): void {
  if (vscodeMockInstalled) return;
  vscodeMockInstalled = true;

  const vscodeMockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vscode-mock-opencode-")), "index.js");
  fs.mkdirSync(path.dirname(vscodeMockPath), { recursive: true });
  fs.writeFileSync(
    vscodeMockPath,
    `"use strict";
  class MarkdownString {
    value = "";
    supportThemeIcons = false;
    isTrusted = false;
    appendMarkdown(_text) {}
  }
  module.exports = {
    ExtensionContext: class {},
    MarkdownString,
    // getUserAgent() probes the extension's package.json for the version;
    // returning undefined falls back to the default UA string.
    extensions: { getExtension: () => undefined },
  };
  `,
    "utf-8",
  );

  type ResolveFilename = (request: string, parent: unknown, ...args: unknown[]) => string;
  const moduleResolver = Module as unknown as {
    _resolveFilename: ResolveFilename;
  };
  const originalResolveFilename = moduleResolver._resolveFilename;
  moduleResolver._resolveFilename = function (request: string, parent: unknown, ...args: unknown[]): string {
    if (request === "vscode") {
      return vscodeMockPath;
    }
    return originalResolveFilename.call(this, request, parent, ...args);
  };
}
