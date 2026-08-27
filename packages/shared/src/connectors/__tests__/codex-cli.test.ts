import { describe, it, expect, vi, beforeEach } from 'vitest'
import child_process from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { CodexCliConnector } from '../codex-cli.js'
import type { NormalizedAgentEvent } from '../../types/index.js'

describe('CodexCliConnector', () => {
  let connector: CodexCliConnector
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
    connector = new CodexCliConnector({ workingDir: '/test/workspace' })
  })

  it('initializes with correct metadata', () => {
    expect(connector.id).toBe('codex-cli')
    expect(connector.name).toBe('Codex CLI')
    expect(connector.capabilities.tools).toContain('file_patch')
    expect(connector.capabilities.tools).toContain('shell_exec')
  })

  it('spawns codex mcp-server on connect', async () => {
    await connector.connect()
    expect(vi.mocked(child_process.spawn)).toHaveBeenCalledWith(
      'codex',
      ['mcp-server'],
      expect.objectContaining({ cwd: '/test/workspace' })
    )
  })

  it('normalizes file_patch event to edit_file NormalizedAgentEvent', () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    connector['handleMCPMessage'](JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'tok-1',
        value: {
          type: 'codex/event',
          event: {
            type: 'file_patch',
            path: 'src/app.ts',
            patch: '@@ -1,3 +1,4 @@\n+import foo'
          }
        }
      }
    }))

    expect(events).toHaveLength(1)
    expect(events[0].tool).toBe('edit_file')
    expect(events[0].params).toEqual({ path: 'src/app.ts', patch: '@@ -1,3 +1,4 @@\n+import foo' })
    expect(events[0].connectorId).toBe('codex-cli')
    expect(events[0].connectorVersion).toBe('1.0.0')
    expect(events[0].mcpEventId).toContain('codex-')
    expect(events[0].rawMCPEvent).toBeDefined()
  })

  it('normalizes shell_exec event to bash NormalizedAgentEvent', () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    connector['handleMCPMessage'](JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'tok-2',
        value: {
          type: 'codex/event',
          event: {
            type: 'shell_exec',
            command: 'npm test',
            output: '3 passing'
          }
        }
      }
    }))

    expect(events).toHaveLength(1)
    expect(events[0].tool).toBe('bash')
    expect(events[0].params).toEqual({ command: 'npm test', output: '3 passing' })
    expect(events[0].connectorId).toBe('codex-cli')
  })

  it('skips message events (text output)', () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    connector['handleMCPMessage'](JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'tok-3',
        value: {
          type: 'codex/event',
          event: { type: 'message', content: 'Done!' }
        }
      }
    }))

    expect(events).toHaveLength(0)
  })

  it('skips non-codex-event progress notifications', () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    connector['handleMCPMessage'](JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'tok-4', value: { percentage: 50 } }
    }))

    expect(events).toHaveLength(0)
  })

  it('generates unique mcpEventId per event', () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    connector['handleMCPMessage'](JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'tok-5', value: { type: 'codex/event', event: { type: 'file_patch', path: 'a.ts', patch: 'x' } } }
    }))
    connector['handleMCPMessage'](JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'tok-6', value: { type: 'codex/event', event: { type: 'file_patch', path: 'b.ts', patch: 'y' } } }
    }))

    expect(events).toHaveLength(2)
    expect(events[0].mcpEventId).not.toBe(events[1].mcpEventId)
  })

  it('disconnects and kills process', async () => {
    await connector.connect()
    const proc = connector['process']
    await connector.disconnect()
    expect(proc?.kill).toHaveBeenCalled()
  })

  it('resets buffer on disconnect', async () => {
    await connector.connect()
    connector['buffer'] = 'partial-data'
    await connector.disconnect()
    expect(connector['buffer']).toBe('')
  })

  it('ignores malformed JSON lines', () => {
    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    connector['handleMCPMessage']('not valid json {{{')
    connector['handleMCPMessage']('')

    expect(events).toHaveLength(0)
  })
})
