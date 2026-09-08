# Issues #218 / #223 — Triage: VS Code dropdown limitation & third-party extension misreport

**Status:** ✅ Solved (triage — no extension defect; branch `fix/issues-216-223-batch`, commit with docs)
**Topic:** triage / default-model-settings / misattribution
**Updated:** 2026-09-08
**Tags:** #triage #utility-model #byok #session-headers
**GitHub Issues:** [#218](https://github.com/ltmoerdani/opencode-copilot-chat/issues/218) · [#223](https://github.com/ltmoerdani/opencode-copilot-chat/issues/223)
**Related:** issue doc [32 (VS Code 1.128 BYOK utility model)](32-20260708-vscode-128-byok-utility-model.md), `src/request/headers.ts`

---

## #218 — Models missing from `inlineChat.defaultModel` / `chat.utilityModel` / … dropdowns

Not an extension defect. Those settings render a **closed dropdown** that only
lists models from providers VS Code itself integrates (Copilot, OpenRouter
built-in). BYOK providers registered through the `chatProvider` API — which is
how OpenCode Go/Zen models appear at all — are not offered in that picker;
this is a VS Code limitation, not something the extension can opt into
(`isUserSelectable: true` is already set on every model we register).

`chat.defaultModel` works for the reporter because it is a free-text field.

Resolution path for users is the existing **OpenCode: Configure Utility
Models** command (shipped after the investigation in doc 32), which sets
`chat.byokUtilityModelDefault` / `chat.utilityModel` / `chat.utilitySmallModel`
explicitly. Closing as "works as designed / upstream limitation"; if a future
VS Code API exposes dropdown registration for BYOK vendors, we can revisit.

## #223 — "[400] Invalid request body format … Request is missing x-opencode-session"

Misattributed to this extension. Decisive evidence in the report itself — the
stack trace belongs to a **different extension**:

```text
at DeepSeekClient.streamChatCompletion
  (/home/marco/.vscode/extensions/vizards.deepseek-v4-for-copilot-0.8.2/
   out/client/core.js:46:23)
```

Our extension has always sent `x-opencode-session` on every request
(`buildOpenCodeRequestHeaders()`, `src/request/headers.ts:40`), with a
stable `vscode-<hash>` fallback when VS Code does not expose a session id,
and every request line in our Output channel logs the `session=` value. The
`MissingSessionID` requirement appears to be new gateway guidance
([OpenCode Go docs — where can I use it](https://opencode.ai/docs/go/#where-can-i-use-it)) that the third-party
extension does not yet satisfy.

Resolution: close with an explanation and point the reporter at
`OpenCode Go: Diagnostics` (which proves our requests carry the session
header) in case their report was a mix-up between two installed extensions.

### Follow-up (2026-09-08): auxiliary requests were missing the header

While the main chat path always sent `x-opencode-session`, an audit triggered
by the same gateway enforcement found **four auxiliary fetch sites** hitting
the gateway without it: `GET /models` (`ModelListFetcher`), inline completions
(`ChatCompletionEngine`), `GET /usage` (`fetchGoUsage`), and the
Manage-Provider test connection. The Go docs (updated 2026-09-07) now state
the requirement explicitly, and per the reporter's note requests missing the
header may error from 2026-09-06. Fixed in commit `8c138e2`: all four now send
a persisted per-installation session id (`auxiliarySessionId()`,
globalState-backed) — no conversation context exists for these requests, so a
stable installation id is the correct affinity key.

## Lessons Learned

1. Extension-version fields in issue templates report the _installed set_, not
   which binary produced a stack trace — always read the full stack before
   accepting attribution.
2. Closed dropdowns in VS Code settings are provider-whitelists, not model
   queries; BYOK workarounds must route through free-text settings.
