import type { AgentAction } from './index.js'

export interface NormalizedAgentEvent extends AgentAction {
  connectorId: string
  connectorVersion: string
  mcpEventId: string
  rawMCPEvent?: unknown
}

export interface MCPEvent {
  id: string
  type: 'tool_call' | 'tool_result' | 'resource_read' | 'notification'
  payload: unknown
  timestamp: number
}
