import { describe, it, expect, vi, beforeEach } from 'vitest'
import child_process from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { ClaudeCodeConnector } from '../claude-code.js'
import type { NormalizedAgentEvent } from '../../types/index.js'

describe('ClaudeCodeConnector', () => {
  let connector: ClaudeCodeConnector
  let mockProcess: {
    stdin: { write: ReturnType<typeof vi.fn> }
    stdout: { on: ReturnType<typeof vi.fn> }
    stderr: { on: ReturnType<typeof vi.fn> }
    on: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    mockProcess = {
      stdin: { write: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn()
    }
    vi.spyOn(child_process, 'spawn').mockReturnValue(
      mockProcess as unknown as ChildProcessWithoutNullStreams
    )
    connector = new ClaudeCodeConnector({ workingDir: '/test/workspace' })
  })

  it('initializes with correct metadata', () => {
    expect(connector.id).toBe('claude-code')
    expect(connector.name).toBe('Claude Code')
    expect(connector.capabilities.tools).toContain('edit_file')
  })

  it('spawns claude process on connect', async () => {
    await connector.connect()
    expect(vi.mocked(child_process.spawn)).toHaveBeenCalledWith(
      'claude',
      ['--mcp'],
      expect.any(Object)
    )
  })

  it('normalizes tool_call MCP event to NormalizedAgentEvent', async () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    // Simulate MCP tool_call from Claude
    const mcpEvent = {
      id: 'mcp-1',
      type: 'tool_call',
      payload: { tool: 'edit_file', params: { path: 'src/foo.ts', content: 'new' } },
      timestamp: Date.now()
    }

    // Trigger internal handler (simulate stdout message)
    connector['handleMCPMessage'](JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: mcpEvent, id: '1' }))

    expect(events).toHaveLength(1)
    expect(events[0].tool).toBe('edit_file')
    expect(events[0].connectorId).toBe('claude-code')
    expect(events[0].mcpEventId).toBe('mcp-1')
  })

  it('normalizes real MCP wire format tools/call into NormalizedAgentEvent', () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    connector['handleMCPMessage'](
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 7,
        params: { name: 'edit_file', arguments: { path: 'src/x.ts', content: 'y' } }
      })
    )

    expect(events).toHaveLength(1)
    expect(events[0].tool).toBe('edit_file')
    expect(events[0].mcpEventId).toBe('7')
    expect(events[0].connectorId).toBe('claude-code')
  })

  it('disconnects and kills process', async () => {
    await connector.connect()
    const proc = connector['process']
    await connector.disconnect()
    expect(proc?.kill).toHaveBeenCalled()
  })
})
