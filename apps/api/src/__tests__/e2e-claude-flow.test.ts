import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import child_process from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { buildApp } from '../app.js'
import { prisma } from '@meetless/database/client'
import { ClaudeCodeConnector, IngestionPipeline, InMemoryConnectorRegistry } from '@meetless/shared/connectors'
import type { NormalizedAgentEvent } from '@meetless/shared/types'

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

async function createSession(name: string) {
  return prisma.session.create({
    data: { workspaceId, userId, name }
  })
}

async function ensureConnector() {
  await prisma.connector.upsert({
    where: { id: 'claude-code' },
    update: {},
    create: { id: 'claude-code', name: 'Claude Code', version: '1.0.0', capabilities: {} }
  })
}

describe('E2E: Claude Code → Meetless full flow', () => {
  it('create connector → register in pipeline → emit MCP event → verify via HTTP', async () => {
    const session = await createSession('E2E Test Session')
    await ensureConnector()

    const registry = new InMemoryConnectorRegistry()
    const pipeline = new IngestionPipeline({ apiBaseUrl: baseUrl, registry })
    const connector = new ClaudeCodeConnector({ workingDir: '/tmp/e2e-test' })
    registry.register(connector)

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

    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 201 } as Response)
    globalThis.fetch = fetchSpy

    await connector.connect()

    const events: NormalizedAgentEvent[] = []
    connector.onEvent(e => events.push(e))

    connector['handleMCPMessage'](
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { id: 'e2e-mcp-1', type: 'tool_call', payload: { tool: 'edit_file', params: { path: 'src/index.ts', content: 'Hello' } } },
        id: 'e2e-mcp-1'
      })
    )

    expect(events).toHaveLength(1)
    events[0].sessionId = session.id
    await pipeline.handleEvent(events[0])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.tool).toBe('edit_file')
    expect(body.connectorId).toBe('claude-code')

    const response = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/conflicts` })
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toHaveLength(0)

    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('detects conflict when two agents edit the same file', async () => {
    const session = await createSession('Conflict E2E')
    await ensureConnector()

    await prisma.connector.upsert({
      where: { id: 'claude-code' },
      update: {},
      create: { id: 'claude-code', name: 'Claude Code', version: '1.0.0', capabilities: {} }
    })

    const agentA = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'claude-1',
        tool: 'edit_file',
        params: { path: 'src/app.ts', content: 'Agent A version' },
        result: { success: true },
        connectorId: 'claude-code',
        connectorVersion: '1.0.0',
        mcpEventId: 'e2e-mcp-2'
      }
    })
    expect(agentA.statusCode).toBe(201)

    const agentB = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'claude-2',
        tool: 'edit_file',
        params: { path: 'src/app.ts', content: 'Agent B version' },
        result: { success: true },
        connectorId: 'claude-code',
        connectorVersion: '1.0.0',
        mcpEventId: 'e2e-mcp-3'
      }
    })
    expect(agentB.statusCode).toBe(201)

    const events = await prisma.normalizedEvent.findMany({ where: { sessionId: session.id } })
    expect(events).toHaveLength(2)

    const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].file).toBe('src/app.ts')
    expect(conflicts[0].agents).toEqual(expect.arrayContaining(['claude-1', 'claude-2']))
    expect(conflicts[0].status).toBe('PENDING')

    const response = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/conflicts` })
    expect(response.statusCode).toBe(200)
    const apiConflicts = JSON.parse(response.payload)
    expect(apiConflicts).toHaveLength(1)
    expect(apiConflicts[0].file).toBe('src/app.ts')

    vi.restoreAllMocks()
  })
})
