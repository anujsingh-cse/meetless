import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { ReconciliationEngine } from '../reconciliation.js'

const prisma = new PrismaClient()

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
    data: { name: 'Broadcast Team', slug: `broadcast-team-${randSuffix()}` }
  })
  const user = await prisma.user.create({
    data: {
      clerkId: `clerk_${randSuffix()}`,
      email: `broadcast-${randSuffix()}@example.com`
    }
  })
  const workspace = await prisma.workspace.create({
    data: { teamId: team.id, name: 'Broadcast Workspace' }
  })
  return prisma.session.create({
    data: { workspaceId: workspace.id, userId: user.id, name }
  })
}

describe('ReconciliationEngine broadcaster', () => {
  let engine: ReconciliationEngine
  let sessionId: string
  let broadcastSpy: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    await prisma.$connect()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    await prisma.normalizedEvent.deleteMany()
    await prisma.conflict.deleteMany()
    await prisma.session.deleteMany()
    await prisma.workspace.deleteMany()
    await prisma.membership.deleteMany()
    await prisma.user.deleteMany()
    await prisma.team.deleteMany()
    await prisma.connector.deleteMany()
    await ensureConnector()
    const session = await createSession('Broadcast Test')
    sessionId = session.id
    broadcastSpy = vi.fn()
    engine = new ReconciliationEngine(prisma, broadcastSpy)
  })

  it('calls broadcaster when conflict is detected', async () => {
    await prisma.normalizedEvent.createMany({
      data: [
        { sessionId, agentId: 'claude-1', tool: 'edit_file', params: { path: 'src/foo.ts', content: 'a' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm1', timestamp: new Date() },
        { sessionId, agentId: 'claude-2', tool: 'edit_file', params: { path: 'src/foo.ts', content: 'b' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm2', timestamp: new Date() }
      ]
    })

    await engine.processSessionEvent({
      sessionId,
      agentId: 'claude-2',
      tool: 'edit_file',
      params: { path: 'src/foo.ts', content: 'b' },
      result: {},
      connectorId: 'claude-code',
      connectorVersion: '1.0',
      mcpEventId: 'm2',
      timestamp: Date.now()
    })

    expect(broadcastSpy).toHaveBeenCalledOnce()
    const call = broadcastSpy.mock.calls[0][0]
    expect(call.type).toBe('conflict_created')
    expect(call.sessionId).toBe(sessionId)
    expect(call.file).toBe('src/foo.ts')
    expect(call.agents).toEqual(expect.arrayContaining(['claude-1', 'claude-2']))
  })

  it('does not call broadcaster when no conflict (identical content)', async () => {
    await prisma.normalizedEvent.createMany({
      data: [
        { sessionId, agentId: 'claude-1', tool: 'edit_file', params: { path: 'src/foo.ts', content: 'same' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm1', timestamp: new Date() },
        { sessionId, agentId: 'claude-2', tool: 'edit_file', params: { path: 'src/foo.ts', content: 'same' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm2', timestamp: new Date() }
      ]
    })

    await engine.processSessionEvent({
      sessionId,
      agentId: 'claude-2',
      tool: 'edit_file',
      params: { path: 'src/foo.ts', content: 'same' },
      result: {},
      connectorId: 'claude-code',
      connectorVersion: '1.0',
      mcpEventId: 'm2',
      timestamp: Date.now()
    })

    expect(broadcastSpy).not.toHaveBeenCalled()
  })
})
