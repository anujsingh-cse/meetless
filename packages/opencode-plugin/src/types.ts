export type OpenCodeEventType = 'tool' | 'file' | 'session' | 'permission'

export interface OpenCodeEventInput {
  sessionId: string
  callId?: string
  tool?: string
  args?: Record<string, unknown>
  filePath?: string
  outputTitle?: string
  outputMeta?: string
  eventType: OpenCodeEventType
  timestamp?: number
}

// Local, structurally identical to @meetless/shared's AgentAction + connector fields,
// so the plugin avoids any runtime dependency on the Node-oriented @meetless/shared config.
export interface NormalizedAgentEvent {
  sessionId: string
  agentId: string
  tool: string
  params: Record<string, unknown>
  result?: Record<string, unknown>
  timestamp: number
  connectorId: string
  connectorVersion: string
  mcpEventId: string
  rawMCPEvent?: unknown
}

export const OPENCODE_EDIT_TOOLS: ReadonlySet<string> = new Set(['edit', 'write', 'patch'])

export const OPENCODE_CONNECTOR_ID = 'opencode'
export const OPENCODE_CONNECTOR_VERSION = '0.0.0'
