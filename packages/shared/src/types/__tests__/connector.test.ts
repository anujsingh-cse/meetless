import { describe, it, expect } from 'vitest'
import type { Connector, NormalizedAgentEvent } from '../index.js'

describe('Connector types', () => {
  it('NormalizedAgentEvent extends AgentAction with connector metadata', () => {
    const event: NormalizedAgentEvent = {
      sessionId: 'sess-1',
      agentId: 'claude-1',
      tool: 'edit_file',
      params: { path: 'src/foo.ts', content: '...' },
      result: { success: true },
      timestamp: Date.now(),
      connectorId: 'claude-code',
      connectorVersion: '1.0.0',
      mcpEventId: 'mcp-evt-123'
    }
    expect(event.connectorId).toBe('claude-code')
    expect(event.mcpEventId).toBeDefined()
  })

  it('Connector interface defines required methods', () => {
    const connector: Connector = {
      id: 'claude-code',
      name: 'Claude Code',
      version: '1.0.0',
      capabilities: { tools: ['edit_file', 'read_file'], resources: [] },
      connect: async () => {},
      disconnect: async () => {},
      onEvent: () => {},
      sendMCPEvent: async () => {}
    }
    expect(connector.id).toBe('claude-code')
    expect(typeof connector.connect).toBe('function')
  })
})
