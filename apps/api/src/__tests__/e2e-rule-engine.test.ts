import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { buildApp } from '../app.js'
import { prisma } from '@meetless/database/client'

let app: Awaited<ReturnType<typeof buildApp>>
let broadcastSpy: ReturnType<typeof vi.fn>

const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function ensureConnector(id: string) {
  await prisma.connector.upsert({ where: { id }, update: {}, create: { id, name: id, version: '1.0.0', capabilities: {} } })
}

beforeAll(async () => {
  app = await buildApp()
  broadcastSpy = vi.fn()
  app.wsManager.broadcastRuleHit = broadcastSpy as never
  await app.listen({ port: 0 })
})

afterAll(async () => {
  await app.close()
})

beforeEach(async () => {
  broadcastSpy.mockClear()
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
})

async function seed(sessionId: string) {
  const team = await prisma.team.create({ data: { name: `T-${randSuffix()}`, slug: `t-${randSuffix()}` } })
  const user = await prisma.user.create({ data: { clerkId: `c-${randSuffix()}`, email: `e-${randSuffix()}@ex.com` } })
  const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'W' } })
  await prisma.session.create({ data: { id: sessionId, workspaceId: workspace.id, userId: user.id, name: 'E2E' } })
  return { workspaceId: workspace.id, sessionId }
}

async function postEvent(sessionId: string, connectorId: string, path: string, agentId: string, mcpEventId: string) {
  return app.inject({
    method: 'POST', url: '/api/events',
    payload: {
      sessionId, agentId, tool: 'edit_file', params: { path, content: `content-${mcpEventId}` }, result: { success: true },
      connectorId, connectorVersion: '1.0.0', mcpEventId,
    },
  })
}

describe('Rule engine E2E', () => {
  it('produces identical rule evaluation for all four connectors and broadcasts NOTIFY once', async () => {
    const { workspaceId, sessionId } = await seed(`e2e-${randSuffix()}`)
    await prisma.rule.create({ data: { workspaceId, name: 'contract', action: 'NOTIFY', pathPattern: 'contracts/**', message: 'authoritative' } })
    await ensureConnector('claude-code')
    await ensureConnector('codex-cli')
    await ensureConnector('cursor-hooks')
    await ensureConnector('opencode')

    const connectors = ['claude-code', 'codex-cli', 'cursor-hooks', 'opencode']
    for (const cid of connectors) {
      const res = await postEvent(sessionId, cid, 'contracts/api.yaml', `${cid}-agent`, `m-${cid}`)
      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.payload)
      expect(body.ruleHits).toHaveLength(1)
      expect(body.ruleHits[0].matchedOn).toEqual({ tool: null, pathPattern: 'contracts/**', connectorId: null, agentPattern: null })
    }

    const hits = await prisma.ruleHit.findMany({ where: { sessionId } })
    expect(hits).toHaveLength(4)
    expect(hits.map((h) => h.connectorId).sort()).toEqual(connectors.sort())
    // one NOTIFY broadcast per hit (4 total), each carrying the persisted hit id
    expect(broadcastSpy).toHaveBeenCalledTimes(4)
    const firstPayload = broadcastSpy.mock.calls[0][1] as { id: string; type?: never }
    expect(hits.some((h) => h.id === (firstPayload as { id: string }).id)).toBe(true)
  })

  it('LOG rules persist hits but do not broadcast; disabled rules never fire', async () => {
    const { workspaceId, sessionId } = await seed(`e2e-${randSuffix()}`)
    await prisma.rule.create({ data: { workspaceId, name: 'log-schema', action: 'LOG', pathPattern: 'prisma/schema.prisma' } })
    await prisma.rule.create({ data: { workspaceId, name: 'disabled', action: 'NOTIFY', pathPattern: '**', enabled: false } })
    await ensureConnector('claude-code')

    const res = await postEvent(sessionId, 'claude-code', 'prisma/schema.prisma', 'claude-1', 'm-log')
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)
    expect(body.ruleHits).toHaveLength(1)
    expect(body.ruleHits[0].action).toBe('LOG')
    expect(broadcastSpy).not.toHaveBeenCalled()
    expect(await prisma.ruleHit.count({ where: { sessionId } })).toBe(1)
  })

  it('reconciliation is unaffected: conflicting edits with an active rule still produce a conflict', async () => {
    const { workspaceId, sessionId } = await seed(`e2e-${randSuffix()}`)
    await prisma.rule.create({ data: { workspaceId, name: 'watch', action: 'NOTIFY', pathPattern: 'src/**' } })
    await ensureConnector('claude-code')
    await ensureConnector('cursor-hooks')

    const r1 = await postEvent(sessionId, 'claude-code', 'src/app.ts', 'claude-1', 'm-c1')
    const r2 = await postEvent(sessionId, 'cursor-hooks', 'src/app.ts', 'cursor-1', 'm-c2')
    expect(r1.statusCode).toBe(201)
    expect(r2.statusCode).toBe(201)

    const conflicts = await prisma.conflict.findMany({ where: { sessionId } })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].status).toBe('PENDING')
    expect(conflicts[0].agents).toEqual(expect.arrayContaining(['claude-1', 'cursor-1']))
    // every edit event produced a hit too
    expect(await prisma.ruleHit.count({ where: { sessionId } })).toBe(2)
  })
})
