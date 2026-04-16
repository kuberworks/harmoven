// lib/llm/plugin-loader.ts
// Extension point for third-party / unofficial LLM provider plugins.
//
// Core Harmoven defines only the interface and registry here.
// Actual plugin implementations live in lib/llm/plugins/<id>/ and are
// loaded at startup via loadLlmPlugins() in lib/bootstrap/load-llm-plugins.ts.
//
// Plugin authors implement ILlmProviderPlugin and call registerLlmPlugin() from
// their plugin's register() function.

import type { LlmProfileConfig } from './profiles'
import type { ChatMessage, ChatOptions, ChatResult } from './interface'

// ─── Plugin contract ───────────────────────────────────────────────────────────

/**
 * Contract every LLM provider plugin must implement.
 *
 * Implement this in your plugin's index.ts and call registerLlmPlugin() from
 * the exported register() function.
 *
 * providerId must match LlmProfileConfig.provider for any profile this plugin
 * handles (e.g. 'copilot' for GitHub Copilot profiles).
 */
export interface ILlmProviderPlugin {
  /** Matches LlmProfileConfig.provider for routing. */
  readonly providerId: string
  /** Profiles contributed by this plugin (runtime-only, not seeded to DB). */
  readonly profiles: LlmProfileConfig[]
  /** Non-streaming completion. */
  chat(
    profile:  LlmProfileConfig,
    messages: ChatMessage[],
    options:  ChatOptions,
  ): Promise<ChatResult>
  /** Streaming completion — call onChunk() per token, return final ChatResult. */
  stream(
    profile:  LlmProfileConfig,
    messages: ChatMessage[],
    options:  ChatOptions,
    onChunk:  (chunk: string) => void,
  ): Promise<ChatResult>
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const _registry = new Map<string, ILlmProviderPlugin>()

export function registerLlmPlugin(plugin: ILlmProviderPlugin): void {
  if (_registry.has(plugin.providerId)) {
    console.warn(`[llm-plugin] Plugin "${plugin.providerId}" already registered — skipping duplicate`)
    return
  }
  _registry.set(plugin.providerId, plugin)
  console.info(
    `[llm-plugin] Loaded provider plugin: ${plugin.providerId} ` +
    `(${plugin.profiles.length} profile(s): ${plugin.profiles.map(p => p.id).join(', ')})`,
  )
}

/** Look up a registered plugin by its providerId. */
export function getLlmPlugin(providerId: string): ILlmProviderPlugin | undefined {
  return _registry.get(providerId)
}

/**
 * All profiles contributed by currently-registered plugins.
 * Merged into the active profile list at DirectLLMClient construction time.
 */
export function getPluginProfiles(): LlmProfileConfig[] {
  return Array.from(_registry.values()).flatMap(p => p.profiles)
}
