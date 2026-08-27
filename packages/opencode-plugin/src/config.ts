import type { EmitterConfig } from './emitter.js'

export interface PluginConfig extends EmitterConfig {
  agentId?: string
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:4096'

export function loadConfig(env: Record<string, string | undefined>): PluginConfig {
  return {
    apiBaseUrl: env.MEETLESS_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    apiToken: env.MEETLESS_API_TOKEN || undefined,
    agentId: env.MEETLESS_AGENT_ID || undefined,
  }
}
