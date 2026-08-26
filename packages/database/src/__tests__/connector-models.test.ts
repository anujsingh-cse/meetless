import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function createSession(name: string) {
  const team = await prisma.team.create({
    data: { name: 'Test Team', slug: `test-team-${randSuffix()}` }
  })
  const user = await prisma.user.create({
    data: {
      clerkId: `clerk_${randSuffix()}`,
      email: `user-${randSuffix()}@example.com`
    }
  })
  const workspace = await prisma.workspace.create({
    data: { teamId: team.id, name: 'Test Workspace' }
  })
  return prisma.session.create({
    data: { workspaceId: workspace.id, userId: user.id, name }
  })
}

describe('Connector Prisma models', () => {
  beforeAll(async () => {
    await prisma.$connect()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  afterEach(async () => {
    await prisma.normalizedEvent.deleteMany()
    await prisma.connector.deleteMany()
    await prisma.conflict.deleteMany()
    await prisma.session.deleteMany()
    await prisma.workspace.deleteMany()
    await prisma.user.deleteMany()
    await prisma.team.deleteMany()
  })

  it('creates and reads a Connector record', async () => {
    const connector = await prisma.connector.create({
      data: {
        id: 'claude-code',
        name: 'Claude Code',
        version: '1.0.0',
        capabilities: { tools: ['edit_file'], resources: [] },
        status: 'disconnected'
      }
    })
    expect(connector.id).toBe('claude-code')
    expect(connector.capabilities).toEqual({ tools: ['edit_file'], resources: [] })
  })

  it('creates and reads a NormalizedEvent record linked to session', async () => {
    const connector = await prisma.connector.create({
      data: {
        id: 'claude-code',
        name: 'Claude Code',
        version: '1.0.0',
        capabilities: { tools: ['edit_file'], resources: [] },
        status: 'connected'
      }
    })
    const session = await createSession('Test Session')
    const event = await prisma.normalizedEvent.create({
      data: {
        sessionId: session.id,
        agentId: 'claude-1',
        tool: 'edit_file',
        params: { path: 'src/foo.ts' },
        result: { success: true },
        connectorId: connector.id,
        connectorVersion: '1.0.0',
        mcpEventId: 'mcp-123',
        timestamp: new Date()
      }
    })
    expect(event.sessionId).toBe(session.id)
    expect(event.connectorId).toBe('claude-code')
  })

  it('enforces uniqueness of (sessionId, file) on Conflict', async () => {
    const session = await createSession('Conflict Unique Test')
    await prisma.conflict.create({
      data: { sessionId: session.id, file: 'src/foo.ts', agents: ['claude-1'], changes: {} }
    })
    await expect(
      prisma.conflict.create({
        data: { sessionId: session.id, file: 'src/foo.ts', agents: ['claude-2'], changes: {} }
      })
    ).rejects.toThrow()
  })
})
