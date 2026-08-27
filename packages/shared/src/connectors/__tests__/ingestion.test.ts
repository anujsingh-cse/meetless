import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IngestionPipeline } from '../ingestion.js'
import { InMemoryConnectorRegistry } from '../registry.js'
import type { NormalizedAgentEvent } from '../../types/index.js'

describe('IngestionPipeline', () => {
  let pipeline: IngestionPipeline
  let registry: InMemoryConnectorRegistry
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchSpy)
    registry = new InMemoryConnectorRegistry()
    pipeline = new IngestionPipeline({ apiBaseUrl: 'http://localhost:3000', registry })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('POSTs event JSON to the API /api/events endpoint', async () => {
    const event: NormalizedAgentEvent = {
      sessionId: 'sess-1',
      agentId: 'claude-1',
      tool: 'edit_file',
      params: { path: 'src/foo.ts', content: 'new' },
      result: { success: true },
      timestamp: Date.now(),
      connectorId: 'claude-code',
      connectorVersion: '1.0.0',
      mcpEventId: 'mcp-123'
    }

    await pipeline.handleEvent(event)

    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/api/events',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-1',
          agentId: 'claude-1',
          tool: 'edit_file',
          params: { path: 'src/foo.ts', content: 'new' },
          result: { success: true },
          connectorId: 'claude-code',
          connectorVersion: '1.0.0',
          mcpEventId: 'mcp-123'
        })
      })
    )
  })

  it('omits result from payload when result is null so the API schema accepts it', async () => {
    const event: NormalizedAgentEvent = {
      sessionId: 'sess-1',
      agentId: 'cursor-1',
      tool: 'edit_file',
      params: { path: 'src/foo.ts', content: 'new' },
      result: null,
      timestamp: Date.now(),
      connectorId: 'cursor-hooks',
      connectorVersion: '1.0.0',
      mcpEventId: 'mcp-999'
    }

    await pipeline.handleEvent(event)

    expect(fetchSpy).toHaveBeenCalledOnce()
    const bodyStr = fetchSpy.mock.calls[0][1].body as string
    const parsed = JSON.parse(bodyStr)
    expect(parsed).not.toHaveProperty('result')
    expect(parsed.connectorId).toBe('cursor-hooks')
  })

  it('logs warning and continues on non-2xx response', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 500 })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const event: NormalizedAgentEvent = {
      sessionId: 'sess-1',
      agentId: 'claude-1',
      tool: 'edit_file',
      params: { path: 'src/foo.ts', content: 'new' },
      result: {},
      timestamp: Date.now(),
      connectorId: 'claude-code',
      connectorVersion: '1.0.0',
      mcpEventId: 'mcp-124'
    }

    await pipeline.handleEvent(event)

    expect(warnSpy).toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })

  it('does not throw when fetch rejects', async () => {
    fetchSpy.mockRejectedValue(new Error('network error'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const event: NormalizedAgentEvent = {
      sessionId: 'sess-1',
      agentId: 'claude-1',
      tool: 'edit_file',
      params: { path: 'src/foo.ts', content: 'new' },
      result: {},
      timestamp: Date.now(),
      connectorId: 'claude-code',
      connectorVersion: '1.0.0',
      mcpEventId: 'mcp-125'
    }

    await expect(pipeline.handleEvent(event)).resolves.not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('registers connector event handlers on start()', async () => {
    const onEventSpy = vi.fn()
    const mockConnector = {
      id: 'claude-code',
      name: 'Claude Code',
      version: '1.0.0',
      capabilities: { tools: ['edit_file'], resources: [] },
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      onEvent: onEventSpy,
      sendMCPEvent: vi.fn().mockResolvedValue(undefined)
    }
    registry.register(mockConnector)

    pipeline.start()

    expect(onEventSpy).toHaveBeenCalledOnce()
    expect(typeof onEventSpy.mock.calls[0][0]).toBe('function')
  })
})
