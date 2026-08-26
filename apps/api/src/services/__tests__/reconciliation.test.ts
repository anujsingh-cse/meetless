import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
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
    data: { name: 'Recon Team', slug: `recon-team-${randSuffix()}` }
  })
  const user = await prisma.user.create({
    data: {
      clerkId: `clerk_${randSuffix()}`,
      email: `recon-${randSuffix()}@example.com`
    }
  })
  const workspace = await prisma.workspace.create({
    data: { teamId: team.id, name: 'Recon Workspace' }
  })
  return prisma.session.create({
    data: { workspaceId: workspace.id, userId: user.id, name }
  })
}

describe('ReconciliationEngine', () => {
  let engine: ReconciliationEngine
  let sessionId: string

  beforeAll(async () => {
    await prisma.$connect()
    engine = new ReconciliationEngine(prisma)
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
    const session = await createSession('Reconciliation Test')
    sessionId = session.id
  })

  it('detects conflict when two agents edit same file', async () => {
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

    const conflicts = await prisma.conflict.findMany({ where: { sessionId } })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].file).toBe('src/foo.ts')
    expect(conflicts[0].agents).toEqual(expect.arrayContaining(['claude-1', 'claude-2']))
  })

  it('does not create conflict for different files', async () => {
    await prisma.normalizedEvent.createMany({
      data: [
        { sessionId, agentId: 'claude-1', tool: 'edit_file', params: { path: 'src/foo.ts', content: 'a' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm1', timestamp: new Date() },
        { sessionId, agentId: 'claude-2', tool: 'edit_file', params: { path: 'src/bar.ts', content: 'b' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm2', timestamp: new Date() }
      ]
    })

    await engine.processSessionEvent({
      sessionId,
      agentId: 'claude-2',
      tool: 'edit_file',
      params: { path: 'src/bar.ts', content: 'b' },
      result: {},
      connectorId: 'claude-code',
      connectorVersion: '1.0',
      mcpEventId: 'm2',
      timestamp: Date.now()
    })

    const conflicts = await prisma.conflict.findMany({ where: { sessionId } })
    expect(conflicts).toHaveLength(0)
  })

  it('does not create conflict when two agents write identical content', async () => {
    const session2 = await createSession('Identical Content Test')
    const sessionId2 = session2.id

    await prisma.normalizedEvent.createMany({
      data: [
        { sessionId: sessionId2, agentId: 'claude-1', tool: 'edit_file', params: { path: 'src/foo.ts', content: 'same' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm1', timestamp: new Date() },
        { sessionId: sessionId2, agentId: 'claude-2', tool: 'edit_file', params: { path: 'src/foo.ts', content: 'same' }, result: {}, connectorId: 'claude-code', connectorVersion: '1.0', mcpEventId: 'm2', timestamp: new Date() }
      ]
    })

    await engine.processSessionEvent({
      sessionId: sessionId2,
      agentId: 'claude-2',
      tool: 'edit_file',
      params: { path: 'src/foo.ts', content: 'same' },
      result: {},
      connectorId: 'claude-code',
      connectorVersion: '1.0',
      mcpEventId: 'm2',
      timestamp: Date.now()
    })

    const conflicts = await prisma.conflict.findMany({ where: { sessionId: sessionId2 } })
    expect(conflicts).toHaveLength(0)
  })
})
