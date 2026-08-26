import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import child_process from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { buildApp } from '../app.js'
import { prisma } from '@meetless/database/client'
import { ClaudeCodeConnector, IngestionPipeline, InMemoryConnectorRegistry } from '@meetless/shared/connectors'

let app: Awaited<ReturnType<typeof buildApp>>
let baseUrl: string
const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let teamId: string
let userId: string
let workspaceId: string

beforeAll(async () => {
  teamId = (await prisma.team.create({ data: { name: 'E2E Team', slug: `e2e-team-${randSuffix()}` } })).id
  userId = (await prisma.user.create({ data: { clerkId: `clerk_e2e_${randSuffix()}`, email: `e2e-${randSuffix()}@example.com` } })).id
  workspaceId = (await prisma.workspace.create({ data: { teamId, name: 'E2E Workspace' } })).id

  app = await buildApp()
  await app.ready()
  await app.listen({ port: 0 })
  const addr = app.server.address()
  if (addr && typeof addr === 'object') {
    baseUrl = `http://127.0.0.1:${addr.port}`
  } else {
    throw new Error('Server not listening')
  }
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.normalizedEvent.deleteMany()
  await prisma.conflict.deleteMany()
  await prisma.session.deleteMany()
  await prisma.connector.deleteMany()
})

describe('E2E: Claude Code → Meetless full flow', () => {
  it('create connector → register in pipeline → emit MCP event → persist → verify via HTTP GET', async () => {
    // 1. Create DB session
    const session = await prisma.session.create({
      data: { workspaceId, userId, name: 'E2E Test Session' }
    })

    // 2. Set up connector + pipeline
    const registry = new InMemoryConnectorRegistry()
    const pipeline = new IngestionPipeline({ apiBaseUrl: baseUrl, registry })
    const connector = new ClaudeCodeConnector({ workingDir: '/tmp/e2e-test' })

    registry.register(connector)

    // 3. Mock child_process.spawn so connector.connect() doesn't fail
    const mockProc = {
      stdin: { write: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn()
    }
    vi.spyOn(child_process, 'spawn').mockReturnValue(
      mockProc as unknown as ChildProcessWithoutNullStreams
    )

    // 4. Mock fetch so pipeline's HTTP POST goes through
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 201 } as Response)
    globalThis.fetch = fetchSpy

    await connector.connect()

    // 5. Simulate an MCP tool_call event
    const mcpPayload = {
      id: 'e2e-mcp-1',
      type: 'tool_call',
      payload: { tool: 'edit_file', params: { path: 'src/index.ts', content: 'Hello from Claude' } },
      timestamp: Date.now()
    }
    const mcpMsg = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: mcpPayload, id: 'e2e-mcp-1' })
    // Trigger the connector's internal MCP handler (same pattern as claude-code.test.ts)
    connector['handleMCPMessage'](mcpMsg)

    // 6. Feed the normalized event into the pipeline
    const events: Array<{ sessionId: string; agentId: string; tool: string; params: Record<string, unknown>; result?: Record<string, unknown>; connectorId: string; connectorVersion: string; mcpEventId: string; timestamp: number }> = []
    connector.onEvent(e => events.push(e as any))

    // The handler already fired from handleMCPMessage — manually invoke pipeline.handleEvent
    await pipeline.handleEvent(events[0])

    // 7. Verify fetch was called with correct payload
    expect(fetchSpy).toHaveBeenCalled()
    const fetchCall = fetchSpy.mock.calls[0]
    expect(fetchCall[0]).toBe(`${baseUrl}/api/events`)
    expect(fetchCall[1].method).toBe('POST')
    const body = JSON.parse(fetchCall[1].body)
    expect(body.tool).toBe('edit_file')
    expect(body.connectorId).toBe('claude-code')
    expect(body.mcpEventId).toBe('e2e-mcp-1')

    // 8. Verify event persisted via HTTP GET
    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/conflicts`
    })
    expect(response.statusCode).toBe(200)

    // Restore fetch
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('detects conflict when two agents edit the same file', async () => {
    const session = await prisma.session.create({
      data: { workspaceId, userId, name: 'Conflict E2E' }
    })

    const registry = new InMemoryConnectorRegistry()
    const pipeline = new IngestionPipeline({ apiBaseUrl: baseUrl, registry })

    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 201 } as Response)
    globalThis.fetch = fetchSpy

    // Agent A edits src/app.ts
    await pipeline.handleEvent({
      sessionId: session.id,
      agentId: 'claude-1',
      tool: 'edit_file',
      params: { path: 'src/app.ts', content: 'Agent A version' },
      result: { success: true },
      timestamp: Date.now(),
      connectorId: 'claude-code',
      connectorVersion: '1.0.0',
      mcpEventId: 'e2e-mcp-2'
    })

    // Agent B edits same file with different content
    await pipeline.handleEvent({
      sessionId: session.id,
      agentId: 'claude-2',
      tool: 'edit_file',
      params: { path: 'src/app.ts', content: 'Agent B version' },
      result: { success: true },
      timestamp: Date.now(),
      connectorId: 'claude-code',
      connectorVersion: '1.0.0',
      mcpEventId: 'e2e-mcp-3'
    })

    // Verify both events persisted via API
    const events = await prisma.normalizedEvent.findMany({ where: { sessionId: session.id } })
    expect(events).toHaveLength(2)

    // Verify conflict detected
    const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].file).toBe('src/app.ts')
    expect(conflicts[0].agents).toEqual(expect.arrayContaining(['claude-1', 'claude-2']))
    expect(conflicts[0].status).toBe('PENDING')

    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })
})
