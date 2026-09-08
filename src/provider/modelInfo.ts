import * as vscode from "vscode";
import {
  CAPACITY_LIMITED_MODEL_NOTES,
  CONFIG_SECTION,
  MODEL_METADATA_REVISION,
  SETTING_SHOW_PROVIDER_PREFIX,
  secretKeyFor,
} from "../config";
import { resolveModelRouting } from "../core/routing";
import { lookupModelRegistryEntry } from "../core/registry";
import { isFreeModel, toEffectiveModelId, type CachedModelMetadataSnapshot, type ResolvedModelMetadata } from "../models/metadata";
import { providerModelDisplayName } from "../models/modelNames";
import { modelPricingFields } from "../models/pricing";
import { GO_VENDOR, ZEN_VENDOR, type ProviderVendor } from "../providerTypes";
import type { ConfiguredLanguageModelInfoOptions, OpenCodeModel, ProviderDefinition } from "./definitions";
import {
  formatModalityBadges,
  getConfiguredApiKey,
  getSettings,
  modelCapabilities,
  modelConfigurationSchema,
  modelLimits,
} from "./settings";
import { ensureProfileSync } from "../usage/dashboard";

// ISSUE #222: VS Code calls provideLanguageModelChatInformation on every UI
// poll. Log the "Models registered" summary only when it actually changes
// (model count, first/last id, variant) so the Output channel stays a
// signal source instead of repeating identical lines.
const LAST_REGISTRATION_LOG_SIGNATURE = new Map<string, string>();

/**
 * Body of `provideLanguageModelChatInformation`: BYOK/secret key resolution,
 * profile registration and per-model `OpenCodeModel` assembly. Pure with
 * respect to the provider class — all state arrives via {@link ModelInfoDeps}.
 */
export interface ModelInfoDeps {
  context: vscode.ExtensionContext;
  baseVendor: ProviderVendor;
  definition: ProviderDefinition;
  log(message: string): void;
  hasByokGroupConfigured(): boolean;
  markByokGroupConfigured(): Promise<void>;
  fetchModels(apiKey?: string, token?: vscode.CancellationToken): Promise<string[]>;
  getMetadataSnapshot(): Promise<CachedModelMetadataSnapshot>;
  resolveModelMetadata(modelId: string, snapshot: CachedModelMetadataSnapshot): ResolvedModelMetadata;
  apiKeysByModelId: Map<string, string>;
}

export async function provideModelChatInformation(
  deps: ModelInfoDeps,
  options: vscode.PrepareLanguageModelChatModelOptions,
  token: vscode.CancellationToken,
): Promise<OpenCodeModel[]> {
  const opts = options as ConfiguredLanguageModelInfoOptions & { group?: string };

  // 1. Try BYOK configuration first (VS Code may supply the API key directly).
  let apiKey = getConfiguredApiKey(opts);

  // A call that carries a BYOK key is a configured-group call. Record that
  // the vendor is configured natively, so the groupless call stays silent
  // (issue #106, see step 2 below).
  if (apiKey) {
    await deps.markByokGroupConfigured();
  } else if (opts.configuration !== undefined) {
    // A group call with a non-undefined configuration that carries no API
    // key is a per-model configuration group (only `settings`, no key —
    // e.g. a `reasoningEffort` picked in the model picker). VS Code
    // resolves its configuration to `{}` here. The groupless call already
    // served the models via SecretStorage, so serving them again would
    // duplicate every model (issue #131). The per-model settings still
    // apply at request time via `modelConfiguration`.
    return [];
  }

  // 2. Fall back to the extension's own secret storage when BYOK did not
  //    provide a usable key. This supports users who stored their key via
  //    the extension's `Set API Key` command instead of VS Code's native
  //    Manage Models / BYOK flow.
  //
  //    CONTRACT: Per vscode.proposed.chatProvider.d.ts, `options.configuration`
  //    is only present when the provider declared a `configurationSchema` in
  //    package.json AND the user has configured a BYOK group. When the user
  //    stored the key via the extension command only, VS Code passes
  //    `configuration=undefined` — this is NOT a "still resolving" state
  //    that will be retried with a BYOK key, it means no BYOK group exists.
  //    Therefore we must consult secret storage unconditionally.
  //
  //    This mirrors the reference implementation in Copilot's own
  //    `AbstractLanguageModelChatProvider.provideLanguageModelChatInformation`,
  //    which always falls back to its own storage when `configuration.apiKey`
  //    is absent (see microsoft/vscode `extensions/copilot/src/extension/byok/
  //    vscode-node/abstractLanguageModelChatProvider.ts`).
  //
  //    See issue #86: non-agent `opencodezen` returned 0 models when the key
  //    was set via the extension command, because the previous guard
  //    `isAgentVariant || options.configuration` skipped the fallback for
  //    non-agent providers with `configuration=undefined`.
  //
  //    ISSUE #106: VS Code calls this method once WITHOUT a group (the
  //    groupless call, `configuration` undefined) and then once per configured
  //    group. It namespaces model identifiers by group (`toModelIdentifier`:
  //    `<vendor>/<group>/<id>` vs `<vendor>/<id>`), so a secrets-backed set
  //    returned on the groupless call is kept ALONGSIDE the group's set and
  //    every model is listed twice. When a BYOK group has been observed (flag
  //    set above), the group call(s) are authoritative — return [] here so the
  //    groupless call does not emit a duplicate set.
  if (!apiKey) {
    if (deps.hasByokGroupConfigured()) {
      return [];
    }
    apiKey = await deps.context.secrets.get(secretKeyFor(deps.baseVendor));
  }

  if (!apiKey) {
    return [];
  }

  // When a non-agent provider resolves its API key, persist it so that
  // agent-variant providers (which have no BYOK entry) can inherit it
  // from the extension's secret storage.
  if (!deps.definition.isAgentVariant) {
    const existing = await deps.context.secrets.get(secretKeyFor(deps.baseVendor));
    if (existing !== apiKey) {
      await deps.context.secrets.store(secretKeyFor(deps.baseVendor), apiKey);
    }
  }

  if (token.isCancellationRequested) {
    return [];
  }

  // Create profile for this API key before fetching models, so the
  // profile is always registered in both the in-memory cache and
  // globalState, regardless of whether a request has been recorded.
  if (deps.baseVendor === GO_VENDOR) {
    ensureProfileSync(apiKey);
  }

  const models = await deps.fetchModels(apiKey, token);
  if (models.length === 0) {
    return [];
  }

  const settings = getSettings();
  const metadataSnapshot = await deps.getMetadataSnapshot();
  const showProviderPrefix = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(SETTING_SHOW_PROVIDER_PREFIX, true);

  // CONTRACT: VS Code calls provideLanguageModelChatInformation frequently
  // (every ~300ms during UI refresh). Per-model logging produces thousands
  // of log lines per minute and obscures real signal. We accumulate a
  // single summary line per invocation instead of one line per model.
  let registeredCount = 0;
  let firstModelId = "";
  let lastModelId = "";

  const results = models.flatMap((modelId) => {
    const metadata = deps.resolveModelMetadata(modelId, metadataSnapshot);
    const routing = resolveModelRouting(modelId, deps.definition);
    const effectiveModelId = toEffectiveModelId(modelId, deps.definition.vendor);
    // Stable model ID — deliberately NO key fingerprint. VS Code's per-model
    // configuration (chatLanguageModels.json) is keyed by this ID; keeping it
    // stable is what makes per-model thinking settings survive restarts and
    // key-source changes (the old `::<fp>` suffix made them go stale and
    // reset — see issue #131). Multi-key resolution relies on the BYOK
    // group's configuration.apiKey; apiKeysByModelId is only a fallback for
    // the SecretStorage path.
    const agentHostModelId = `${effectiveModelId}::agent-host`;
    const limits = modelLimits(metadata, settings);
    deps.apiKeysByModelId.set(modelId, apiKey);
    deps.apiKeysByModelId.set(effectiveModelId, apiKey);
    deps.apiKeysByModelId.set(agentHostModelId, apiKey);

    const capacityNote = CAPACITY_LIMITED_MODEL_NOTES[modelId];
    const modalityBadges = formatModalityBadges(metadata);
    const baseDetail = deps.baseVendor === ZEN_VENDOR && isFreeModel(modelId) ? "Free" : deps.definition.displayName;
    const baseTooltip = `${deps.definition.displayName} model: ${modelId}`;
    const configurationSchema = modelConfigurationSchema(modelId, metadata);

    const sharedFields: Omit<OpenCodeModel, "id" | "targetChatSessionType"> = {
      rawModelId: modelId,
      name: providerModelDisplayName(deps.definition.modelNamePrefix, modelId, showProviderPrefix),
      // A stable real family name (e.g. "deepseek", "gpt") so VS Code's
      // family-based model selection/grouping works — a per-model unique
      // string previously broke `modelFamily` routing and sticky grouping.
      family: lookupModelRegistryEntry(modelId).family,
      // Include effective limits in version so VS Code invalidates stale
      // picker metadata after limit changes (eg. 2M -> 262K corrections).
      version: `1.2.0-${MODEL_METADATA_REVISION}-${String(limits.contextWindow)}-${String(limits.maxOutputTokens)}`,
      detail: capacityNote ? `${baseDetail} • Limited capacity` : modalityBadges ? `${baseDetail} • ${modalityBadges}` : baseDetail,
      tooltip: capacityNote ? `${baseTooltip}\n\n${capacityNote}` : modalityBadges ? `${baseTooltip}\n\n${modalityBadges}` : baseTooltip,
      isUserSelectable: true,
      isBYOK: true,
      maxInputTokens: limits.advertisedMaxInputTokens,
      maxOutputTokens: limits.advertisedMaxOutputTokens,
      capabilities: modelCapabilities(metadata),
      endpointKind: routing.endpointKind,
      provider: deps.definition,
      ...(capacityNote ? { warningText: { capacity: capacityNote } } : {}),
      // Pricing fields (VS Code languageModelPricing proposal)
      ...modelPricingFields(modelId, deps.baseVendor, metadata),
      // Inline so Copilot Chat picks up the Thinking submenu directly
      // (parity with zelosleone/Opencode-Go-For-Copilot pattern).
      ...(configurationSchema ? { configurationSchema } : {}),
    };

    if (deps.definition.isAgentVariant) {
      // Agent-host variant — only returned by agent providers.
      // targetChatSessionType must match the `type` declared in the
      // Copilot extension's chatSessions contribution:
      //   { "type": "copilotcli", "requiresCustomModels": true, ... }
      const agentHostInfo: OpenCodeModel = {
        ...sharedFields,
        id: agentHostModelId,
        targetChatSessionType: "copilotcli",
      };

      registeredCount += 1;
      if (!firstModelId) firstModelId = agentHostInfo.id;
      lastModelId = agentHostInfo.id;
      return [agentHostInfo];
    }

    // General variant — no targetChatSessionType → visible in Chat view
    const info: OpenCodeModel = { ...sharedFields, id: effectiveModelId };

    registeredCount += 1;
    if (!firstModelId) firstModelId = info.id;
    lastModelId = info.id;
    return [info];
  });

  // Single summary log line per invocation — includes count + first/last
  // model ID so we can still debug registration issues without flooding
  // the Output channel when VS Code refreshes model info frequently.
  if (registeredCount > 0) {
    const signature =
      `count=${String(registeredCount)} provider=${deps.definition.vendor}` +
      ` first=${firstModelId} last=${lastModelId}` +
      (deps.definition.isAgentVariant ? " (agents)" : "");
    const logKey = deps.definition.isAgentVariant ? `${deps.definition.vendor}::agents` : deps.definition.vendor;
    if (LAST_REGISTRATION_LOG_SIGNATURE.get(logKey) !== signature) {
      LAST_REGISTRATION_LOG_SIGNATURE.set(logKey, signature);
      deps.log(`Models registered: ${signature}`);
    }
  }

  return results;
}
