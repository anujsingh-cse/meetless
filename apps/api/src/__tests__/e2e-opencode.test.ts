import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildApp } from '../app.js'
import { prisma } from '@meetless/database/client'
import { normalizeOpenCodeEvent, emitToMeetless } from '@meetless/opencode'
import type { EmitterConfig } from '@meetless/opencode'

let app: Awaited<ReturnType<typeof buildApp>>
const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let teamId: string
let userId: string
let workspaceId: string

beforeAll(async () => {
  teamId = (await prisma.team.create({ data: { name: 'OC E2E Team', slug: `oc-e2e-${randSuffix()}` } })).id
  userId = (await prisma.user.create({ data: { clerkId: `clerk_oc_${randSuffix()}`, email: `oc-e2e-${randSuffix()}@example.com` } })).id
  workspaceId = (await prisma.workspace.create({ data: { teamId, name: 'OC E2E Workspace' } })).id

  app = await buildApp()
  await app.ready()
  await app.listen({ port: 0 })
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

describe('E2E: OpenCode → reconciliation', () => {
  it('OpenCode edit_file event joins the same session and conflicts with Claude', async () => {
    // A Meetless session whose id we choose to match the OpenCode sessionID.
    const sessionId = `oc-e2e-${randSuffix()}`
    await prisma.session.create({
      data: { id: sessionId, workspaceId, userId, name: 'OpenCode Claude Conflict' },
    })

    await prisma.connector.upsert({
      where: { id: 'opencode' }, update: {},
      create: { id: 'opencode', name: 'OpenCode', version: '0.0.0', capabilities: {} },
    })
    await prisma.connector.upsert({
      where: { id: 'claude-code' }, update: {},
      create: { id: 'claude-code', name: 'Claude Code', version: '1.0.0', capabilities: {} },
    })

    const addr = app.server.address()
    if (!addr || typeof addr !== 'object') throw new Error('Server not listening')
    const baseUrl = `http://127.0.0.1:${addr.port}`
    const emitterConfig: EmitterConfig = { apiBaseUrl: baseUrl }

    // Step 1: OpenCode event -> normalize -> emit through the SAME emitter the plugin uses.
    const openCodeEvent = normalizeOpenCodeEvent({
      sessionId,
      callId: `oc-call-${randSuffix()}`,
      tool: 'edit',
      args: { filePath: 'src/app.ts', content: 'function main() { return "OpenCode" }' },
      eventType: 'tool',
    }, { connectorId: 'opencode', connectorVersion: '0.0.0', agentId: 'opencode-agent' })
    expect(openCodeEvent).not.toBeNull()
    await emitToMeetless(emitterConfig, openCodeEvent!)

    // Step 2: Claude edits the SAME file in the SAME session.
    const claudeRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId,
        agentId: 'claude-1',
        tool: 'edit_file',
        params: { path: 'src/app.ts', content: 'function main() { return "Claude" }' },
        result: { success: true },
        connectorId: 'claude-code',
        connectorVersion: '1.0.0',
        mcpEventId: `claude-oc-${randSuffix()}`,
      },
    })
    expect(claudeRes.statusCode).toBe(201)

    const events = await prisma.normalizedEvent.findMany({ where: { sessionId } })
    expect(events.map((e) => e.connectorId).sort()).toEqual(['claude-code', 'opencode'])

    const conflicts = await prisma.conflict.findMany({ where: { sessionId } })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].file).toBe('src/app.ts')
    expect(conflicts[0].agents).toEqual(expect.arrayContaining(['opencode-agent', 'claude-1']))
    expect(conflicts[0].status).toBe('PENDING')
  })
})
