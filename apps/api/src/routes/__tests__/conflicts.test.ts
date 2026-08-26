import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../../app.js'

const prisma = new PrismaClient()

const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function ensureConnector() {
  await prisma.connector.upsert({
    where: { id: 'claude-code' },
    update: {},
    create: { id: 'claude-code', name: 'Claude Code', version: '1.0.0', capabilities: {} }
  })
}

async function createSessionWithConflict() {
  const team = await prisma.team.create({
    data: { name: 'Resolve Team', slug: `resolve-team-${randSuffix()}` }
  })
  const user = await prisma.user.create({
    data: {
      clerkId: `clerk_${randSuffix()}`,
      email: `resolve-${randSuffix()}@example.com`
    }
  })
  const workspace = await prisma.workspace.create({
    data: { teamId: team.id, name: 'Resolve Workspace' }
  })
  const session = await prisma.session.create({
    data: { workspaceId: workspace.id, userId: user.id, name: 'Resolve Test' }
  })
  const conflict = await prisma.conflict.create({
    data: {
      sessionId: session.id,
      file: 'src/foo.ts',
      agents: ['claude-1', 'claude-2'],
      changes: { edits: [{ agent: 'claude-1', content: 'a' }, { agent: 'claude-2', content: 'b' }] },
      status: 'PENDING'
    }
  })
  return { session, conflict }
}

describe('POST /api/conflicts/:conflictId/resolve', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    await prisma.$connect()
    await ensureConnector()
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
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
  })

  it('resolves a conflict with accept_agent resolution', async () => {
    const { conflict } = await createSessionWithConflict()

    const response = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${conflict.id}/resolve`,
      payload: { resolution: 'accept_agent', resolvedBy: 'user-1' }
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.payload)
    expect(body.id).toBe(conflict.id)
    expect(body.status).toBe('RESOLVED')
    expect(body.resolution).toBe('accept_agent')

    const updated = await prisma.conflict.findUnique({ where: { id: conflict.id } })
    expect(updated!.status).toBe('RESOLVED')
    const changes = updated!.changes as Record<string, unknown>
    expect(changes.resolution).toBe('accept_agent')
    expect(changes.resolvedBy).toBe('user-1')
  })

  it('resolves with merge_manual and stores mergedContent', async () => {
    const { conflict } = await createSessionWithConflict()

    const response = await app.inject({
      method: 'POST',
      url: `/api/conflicts/${conflict.id}/resolve`,
      payload: {
        resolution: 'merge_manual',
        resolvedBy: 'user-1',
        mergedContent: 'merged content here'
      }
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.payload)
    expect(body.resolution).toBe('merge_manual')

    const updated = await prisma.conflict.findUnique({ where: { id: conflict.id } })
    const changes = updated!.changes as Record<string, unknown>
    expect(changes.mergedContent).toBe('merged content here')
  })

  it('returns 404 for non-existent conflict', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/conflicts/non-existent-id/resolve',
      payload: { resolution: 'reject_changes', resolvedBy: 'user-1' }
    })

    expect(response.statusCode).toBe(404)
    const body = JSON.parse(response.payload)
    expect(body.error).toBe('Conflict not found')
  })
})
