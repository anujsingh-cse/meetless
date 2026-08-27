import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildApp } from '../app.js'
import { prisma } from '@meetless/database/client'
import { CodexCliConnector, ClaudeCodeConnector, IngestionPipeline, InMemoryConnectorRegistry } from '@meetless/shared/connectors'

let app: Awaited<ReturnType<typeof buildApp>>
let baseUrl: string
const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let teamId: string
let userId: string
let workspaceId: string

beforeAll(async () => {
  teamId = (await prisma.team.create({ data: { name: 'Multi Team', slug: `multi-team-${randSuffix()}` } })).id
  userId = (await prisma.user.create({ data: { clerkId: `clerk_multi_${randSuffix()}`, email: `multi-${randSuffix()}@example.com` } })).id
  workspaceId = (await prisma.workspace.create({ data: { teamId, name: 'Multi Workspace' } })).id

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
  return prisma.session.create({ data: { workspaceId, userId, name } })
}

describe('E2E: Multi-connector conflict detection', () => {
  it('detects conflict between Codex and Claude editing the same file', async () => {
    const session = await createSession('Multi-Connector Test')

    await prisma.connector.upsert({
      where: { id: 'codex-cli' },
      update: {},
      create: { id: 'codex-cli', name: 'Codex CLI', version: '1.0.0', capabilities: {} }
    })
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
        agentId: 'codex-1',
        tool: 'edit_file',
        params: { path: 'src/app.ts', patch: '@@ -1 +1,2 @@\n+import codex' },
        connectorId: 'codex-cli',
        connectorVersion: '1.0.0',
        mcpEventId: `multi-codex-${randSuffix()}`
      }
    })
    expect(agentA.statusCode).toBe(201)

    const agentB = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'claude-1',
        tool: 'edit_file',
        params: { path: 'src/app.ts', content: 'function main() { return "B" }' },
        result: { success: true },
        connectorId: 'claude-code',
        connectorVersion: '1.0.0',
        mcpEventId: `multi-claude-${randSuffix()}`
      }
    })
    expect(agentB.statusCode).toBe(201)

    const events = await prisma.normalizedEvent.findMany({ where: { sessionId: session.id } })
    expect(events).toHaveLength(2)
    expect(events.map(e => e.connectorId).sort()).toEqual(['claude-code', 'codex-cli'])

    const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].file).toBe('src/app.ts')
    expect(conflicts[0].agents).toEqual(expect.arrayContaining(['codex-1', 'claude-1']))
    expect(conflicts[0].status).toBe('PENDING')

    const resp = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/conflicts` })
    expect(resp.statusCode).toBe(200)
    const apiConflicts = JSON.parse(resp.payload)
    expect(apiConflicts).toHaveLength(1)
    expect(apiConflicts[0].agents).toEqual(expect.arrayContaining(['codex-1', 'claude-1']))
  })

  it('no conflict when Codex and Claude edit different files', async () => {
    const session = await createSession('Different Files Test')

    await prisma.connector.upsert({
      where: { id: 'codex-cli' },
      update: {},
      create: { id: 'codex-cli', name: 'Codex CLI', version: '1.0.0', capabilities: {} }
    })
    await prisma.connector.upsert({
      where: { id: 'claude-code' },
      update: {},
      create: { id: 'claude-code', name: 'Claude Code', version: '1.0.0', capabilities: {} }
    })

    await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'codex-1',
        tool: 'edit_file',
        params: { path: 'src/a.ts', patch: 'x' },
        connectorId: 'codex-cli',
        connectorVersion: '1.0.0',
        mcpEventId: `diff-codex-${randSuffix()}`
      }
    })

    await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'claude-1',
        tool: 'edit_file',
        params: { path: 'src/b.ts', content: 'y' },
        result: { success: true },
        connectorId: 'claude-code',
        connectorVersion: '1.0.0',
        mcpEventId: `diff-claude-${randSuffix()}`
      }
    })

    const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
    expect(conflicts).toHaveLength(0)
  })
})
