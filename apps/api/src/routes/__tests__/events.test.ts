import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildApp } from '../../app.js'
import { prisma } from '@meetless/database/client'

let app: Awaited<ReturnType<typeof buildApp>>

const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function ensureConnector() {
  await prisma.connector.upsert({
    where: { id: 'claude-code' },
    update: {},
    create: { id: 'claude-code', name: 'Claude Code', version: '1.0.0', capabilities: {} }
  })
}

async function createSession(name: string) {
  const team = await prisma.team.create({
    data: { name: 'Events Team', slug: `events-team-${randSuffix()}` }
  })
  const user = await prisma.user.create({
    data: {
      clerkId: `clerk_${randSuffix()}`,
      email: `events-${randSuffix()}@example.com`
    }
  })
  const workspace = await prisma.workspace.create({
    data: { teamId: team.id, name: 'Events Workspace' }
  })
  return prisma.session.create({
    data: { workspaceId: workspace.id, userId: user.id, name }
  })
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

beforeEach(async () => {
  await prisma.normalizedEvent.deleteMany()
  await prisma.conflict.deleteMany()
  await prisma.ruleHit.deleteMany()
  await prisma.rule.deleteMany()
  await prisma.session.deleteMany()
  await prisma.workspace.deleteMany()
  await prisma.membership.deleteMany()
  await prisma.user.deleteMany()
  await prisma.team.deleteMany()
  await prisma.connector.deleteMany()
  await ensureConnector()
})

describe('POST /api/events', () => {
  it('accepts normalized agent event and persists to database', async () => {
    const session = await createSession('Ingestion Test')

    const response = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: session.id,
        agentId: 'claude-1',
        tool: 'edit_file',
        params: { path: 'src/foo.ts', content: 'new content' },
        result: { success: true },
        connectorId: 'claude-code',
        connectorVersion: '1.0.0',
        mcpEventId: 'mcp-123'
      }
    })

    expect(response.statusCode).toBe(201)
    const body = JSON.parse(response.payload)
    expect(body.id).toBeDefined()
    expect(body.sessionId).toBe(session.id)
    expect(body.tool).toBe('edit_file')

    const persisted = await prisma.normalizedEvent.findUnique({ where: { id: body.id } })
    expect(persisted).not.toBeNull()
    expect(persisted?.mcpEventId).toBe('mcp-123')
  })

  it('rejects events with invalid sessionId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId: 'invalid-session',
        agentId: 'claude-1',
        tool: 'edit_file',
        params: { path: 'src/foo.ts' },
        connectorId: 'claude-code',
        connectorVersion: '1.0.0',
        mcpEventId: 'mcp-123'
      }
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('GET /api/sessions/:sessionId/conflicts', () => {
  it('returns conflicts for a session', async () => {
    const session = await createSession('Conflict List Test')
    await prisma.normalizedEvent.createMany({
      data: [
        { sessionId: session.id, agentId: 'claude-1', tool: 'edit_file', params: { path: 'src/foo.ts', content: 'a' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm1', timestamp: new Date() },
        { sessionId: session.id, agentId: 'claude-2', tool: 'edit_file', params: { path: 'src/foo.ts', content: 'b' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm2', timestamp: new Date() }
      ]
    })
    await prisma.conflict.create({
      data: {
        sessionId: session.id,
        file: 'src/foo.ts',
        agents: ['claude-1', 'claude-2'],
        changes: { edits: [] }
      }
    })

    const response = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/conflicts`
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.payload)
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(1)
    expect(body[0].file).toBe('src/foo.ts')
    expect(body[0].agents).toEqual(expect.arrayContaining(['claude-1', 'claude-2']))
  })
})

describe('rules in event ingestion', () => {
  it('persists a NOTIFY hit and returns ruleHits when a rule matches', async () => {
    const session = await createSession('Rules Ingest')
    const rule = await prisma.rule.create({
      data: { workspaceId: session.workspaceId, name: 'protect', action: 'NOTIFY', pathPattern: 'config/prod/**', message: 'off-limits' },
    })

    const res = await app.inject({
      method: 'POST', url: '/api/events',
      payload: {
        sessionId: session.id, agentId: 'claude-1', tool: 'edit_file',
        params: { path: 'config/prod/app.yaml', content: 'x' }, result: { success: true },
        connectorId: 'claude-code', connectorVersion: '1.0.0', mcpEventId: 'm-r1',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)
    expect(body.ruleHits).toHaveLength(1)
    expect(body.ruleHits[0].ruleId).toBe(rule.id)
    expect(body.ruleHits[0].action).toBe('NOTIFY')

    const hit = await prisma.ruleHit.findFirst({ where: { sessionId: session.id } })
    expect(hit).not.toBeNull()
    expect(hit?.ruleName).toBe('protect')
    expect(hit?.matchedOn).toEqual({ tool: null, pathPattern: 'config/prod/**', connectorId: null, agentPattern: null })
    expect(hit?.id).toBe(body.ruleHits[0].id)
  })

  it('omits ruleHits when no rule matches', async () => {
    const session = await createSession('Rules None')
    const res = await app.inject({
      method: 'POST', url: '/api/events',
      payload: {
        sessionId: session.id, agentId: 'claude-1', tool: 'edit_file',
        params: { path: 'src/app.ts', content: 'x' }, result: { success: true },
        connectorId: 'claude-code', connectorVersion: '1.0.0', mcpEventId: 'm-r2',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)
    expect(body.ruleHits).toBeUndefined()
  })

  it('still returns 201 and persists the event when a stored rule has an invalid glob (failure isolation)', async () => {
    const session = await createSession('Rules Faulty')
    await prisma.rule.create({
      data: { workspaceId: session.workspaceId, name: 'bad', action: 'NOTIFY', pathPattern: 'config(prod/**' },
    })
    const res = await app.inject({
      method: 'POST', url: '/api/events',
      payload: {
        sessionId: session.id, agentId: 'claude-1', tool: 'edit_file',
        params: { path: 'config/prod/app.yaml', content: 'x' }, result: { success: true },
        connectorId: 'claude-code', connectorVersion: '1.0.0', mcpEventId: 'm-r3',
      },
    })
    expect(res.statusCode).toBe(201)
    const persisted = await prisma.normalizedEvent.findFirst({ where: { mcpEventId: 'm-r3' } })
    expect(persisted).not.toBeNull()
  })
})
