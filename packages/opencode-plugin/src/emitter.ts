import type { NormalizedAgentEvent } from './types.js'

export interface EmitterConfig {
  apiBaseUrl: string
  apiToken?: string
}

export async function emitToMeetless(config: EmitterConfig, event: NormalizedAgentEvent): Promise<void> {
  const payload: Record<string, unknown> = {
    sessionId: event.sessionId,
    agentId: event.agentId,
    tool: event.tool,
    params: event.params,
    connectorId: event.connectorId,
    connectorVersion: event.connectorVersion,
    mcpEventId: event.mcpEventId,
  }
  if (event.result !== undefined && event.result !== null) {
    payload.result = event.result
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.apiToken) headers.Authorization = `Bearer ${config.apiToken}`

  try {
    const res = await fetch(`${config.apiBaseUrl}/api/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[opencode-plugin] /api/events returned ${res.status} for event ${event.mcpEventId}: ${text}`)
    }
  } catch (err) {
    console.warn(`[opencode-plugin] failed to forward event ${event.mcpEventId}:`, err)
  }
}
