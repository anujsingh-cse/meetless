import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { prisma } from '@meetless/database/client'

let app: Awaited<ReturnType<typeof buildApp>>

const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function createSession() {
  const team = await prisma.team.create({ data: { name: `T-${randSuffix()}`, slug: `t-${randSuffix()}` } })
  const user = await prisma.user.create({ data: { clerkId: `c-${randSuffix()}`, email: `e-${randSuffix()}@ex.com` } })
  const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'W' } })
  const session = await prisma.session.create({ data: { workspaceId: workspace.id, userId: user.id, name: 'Dec' } })
  return { sessionId: session.id, workspaceId: workspace.id }
}

const decisionBody = (sessionId: string, path: string) => ({
  sessionId, agentId: 'claude-1', connectorId: 'claude-code', tool: 'edit_file',
  params: { path, content: 'x' },
})

beforeAll(async () => { app = await buildApp(); await app.ready() })
afterAll(async () => { await app.close() })

beforeEach(async () => {
  await prisma.normalizedEvent.deleteMany()
  await prisma.conflict.deleteMany()
  await prisma.ruleHit.deleteMany()
  await prisma.ruleDecision.deleteMany()
  await prisma.rule.deleteMany()
  await prisma.session.deleteMany()
  await prisma.workspace.deleteMany()
  await prisma.membership.deleteMany()
  await prisma.user.deleteMany()
  await prisma.team.deleteMany()
  await prisma.connector.deleteMany()
})

describe('POST /api/decisions', () => {
  it('returns allow with no attribution when no prevention rule matches', async () => {
    const { sessionId, workspaceId } = await createSession()
    await prisma.rule.create({ data: { workspaceId, name: 'deny-contracts', action: 'NOTIFY', decision: 'DENY', pathPattern: 'contracts/**' } })
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: decisionBody(sessionId, 'src/app.ts') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ decision: 'allow' })
    expect(await prisma.ruleDecision.count({ where: { sessionId } })).toBe(0)
  })

  it('returns deny with reason when a DENY prevention rule matches', async () => {
    const { sessionId, workspaceId } = await createSession()
    const rule = await prisma.rule.create({ data: { workspaceId, name: 'deny-prod', action: 'NOTIFY', decision: 'DENY', pathPattern: 'config/prod/**', message: 'off-limits' } })
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: decisionBody(sessionId, 'config/prod/app.yaml') })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.decision).toBe('deny')
    expect(body.ruleId).toBe(rule.id)
    expect(body.ruleName).toBe('deny-prod')
    expect(body.reason).toBe('off-limits')
  })

  it('persists a RuleDecision audit row and creates NO RuleHit / NormalizedEvent rows', async () => {
    const { sessionId, workspaceId } = await createSession()
    const rule = await prisma.rule.create({ data: { workspaceId, name: 'deny-prod', action: 'NOTIFY', decision: 'DENY', pathPattern: 'config/prod/**' } })
    await app.inject({ method: 'POST', url: '/api/decisions', payload: decisionBody(sessionId, 'config/prod/app.yaml') })
    const decision = await prisma.ruleDecision.findFirst({ where: { sessionId } })
    expect(decision).not.toBeNull()
    expect(decision?.ruleId).toBe(rule.id)
    expect(decision?.verdict).toBe('DENY')
    expect(decision?.matchedOn).toEqual({ tool: null, pathPattern: 'config/prod/**', connectorId: null, agentPattern: null })
    expect(await prisma.ruleHit.count({ where: { sessionId } })).toBe(0)
    expect(await prisma.normalizedEvent.count({ where: { sessionId } })).toBe(0)
  })

  it('LOG/NOTIFY rules never deny and produce no audit rows on the decision path', async () => {
    const { sessionId, workspaceId } = await createSession()
    await prisma.rule.create({ data: { workspaceId, name: 'notify', action: 'NOTIFY', pathPattern: 'config/**' } })
    await prisma.rule.create({ data: { workspaceId, name: 'log', action: 'LOG', pathPattern: 'config/**' } })
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: decisionBody(sessionId, 'config/prod/x') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).decision).toBe('allow')
    expect(await prisma.ruleDecision.count({ where: { sessionId } })).toBe(0)
    expect(await prisma.ruleHit.count({ where: { sessionId } })).toBe(0)
  })

  it('deny precedence: DENY wins over ALLOW and all matches are audited', async () => {
    const { sessionId, workspaceId } = await createSession()
    const deny = await prisma.rule.create({ data: { workspaceId, name: 'deny', action: 'NOTIFY', decision: 'DENY', pathPattern: 'config/**', priority: 10 } })
    const allow = await prisma.rule.create({ data: { workspaceId, name: 'allow', action: 'NOTIFY', decision: 'ALLOW', pathPattern: 'config/**', priority: 20 } })
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: decisionBody(sessionId, 'config/x') })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.decision).toBe('deny')
    expect(body.ruleId).toBe(deny.id) // deterministic winner: first DENY in priority order
    const rows = await prisma.ruleDecision.findMany({ where: { sessionId } })
    expect(rows.map((r) => r.ruleId).sort()).toEqual([deny.id, allow.id].sort())
    expect(rows.map((r) => r.verdict).sort()).toEqual(['ALLOW', 'DENY'])
  })

  it('returns 400 for an unknown sessionId', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: decisionBody('nope', 'src/x') })
    expect(res.statusCode).toBe(400)
  })

  it('fail-open: a server error returns 200 allow (residual 500 is catastrophic-only)', async () => {
    const { sessionId } = await createSession()
    const original = app.prisma.rule.findMany.bind(app.prisma.rule)
    app.prisma.rule.findMany = (async () => { throw new Error('boom') }) as never
    try {
      const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: decisionBody(sessionId, 'src/x') })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload)).toEqual({ decision: 'allow' })
    } finally {
      app.prisma.rule.findMany = original as never
    }
  })
})

describe('POST /api/decisions — ASK', () => {
  it('returns an ask verdict with a pendingId when an ASK rule matches', async () => {
    const { sessionId, workspaceId } = await createSession()
    const rule = await prisma.rule.create({ data: { workspaceId, name: 'ask-prod', action: 'NOTIFY', decision: 'ASK', pathPattern: 'config/prod/**', message: 'Needs review' } })
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: { ...decisionBody(sessionId, 'config/prod/app.yaml'), pendingKey: 'oc-req-1' } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.decision).toBe('ask')
    expect(body.pendingId).toMatch(/./)
    expect(body.ruleId).toBe(rule.id)
    expect(body.ruleName).toBe('ask-prod')
    expect(body.reason).toBe('Needs review')
    expect(body.expiresAt).toMatch(/./)

    const row = await prisma.ruleDecision.findFirst({ where: { sessionId } })
    expect(row?.status).toBe('PENDING')
    expect(row?.verdict).toBe('ASK')
    expect(row?.pendingKey).toBe('oc-req-1')
  })

  it('duplicate ASK for the same (connector, session, pendingKey) returns the existing pendingId', async () => {
    const { sessionId, workspaceId } = await createSession()
    await prisma.rule.create({ data: { workspaceId, name: 'ask-prod', action: 'NOTIFY', decision: 'ASK', pathPattern: 'config/prod/**' } })
    const payload = { ...decisionBody(sessionId, 'config/prod/app.yaml'), pendingKey: 'oc-req-1' }
    const a = await app.inject({ method: 'POST', url: '/api/decisions', payload })
    const b = await app.inject({ method: 'POST', url: '/api/decisions', payload })
    expect(JSON.parse(a.payload).pendingId).toBe(JSON.parse(b.payload).pendingId)
    expect(await prisma.ruleDecision.count({ where: { sessionId } })).toBe(1)
  })

  it('deny still wins over ask (precedence regression)', async () => {
    const { sessionId, workspaceId } = await createSession()
    await prisma.rule.create({ data: { workspaceId, name: 'ask', action: 'NOTIFY', decision: 'ASK', pathPattern: 'config/**', priority: 10 } })
    await prisma.rule.create({ data: { workspaceId, name: 'deny', action: 'NOTIFY', decision: 'DENY', pathPattern: 'config/prod/**', priority: 20 } })
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: { ...decisionBody(sessionId, 'config/prod/x'), pendingKey: 'oc-req-x' } })
    expect(JSON.parse(res.payload).decision).toBe('deny')
    expect(await prisma.ruleDecision.count({ where: { sessionId, status: 'PENDING' } })).toBe(0)
  })
})

describe('POST /api/decisions/:pendingId/approve and deny', () => {
  async function createAskPending() {
    const { sessionId, workspaceId } = await createSession()
    await prisma.rule.create({ data: { workspaceId, name: 'ask-prod', action: 'NOTIFY', decision: 'ASK', pathPattern: 'config/prod/**', message: 'Needs review' } })
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: { ...decisionBody(sessionId, 'config/prod/app.yaml'), pendingKey: `oc-${randSuffix()}` } })
    const body = JSON.parse(res.payload)
    return { sessionId, pendingId: body.pendingId as string }
  }

  it('approve: PENDING → APPROVED with resolution metadata', async () => {
    const { pendingId } = await createAskPending()
    const res = await app.inject({ method: 'POST', url: `/api/decisions/${pendingId}/approve`, payload: {} })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.status).toBe('APPROVED')
    expect(body.resolvedAt).toBeTruthy()
    const row = await prisma.ruleDecision.findUnique({ where: { id: pendingId } })
    expect(row?.status).toBe('APPROVED')
    expect(row?.resolutionMethod).toBe('api')
    expect(row?.resolvedBy).not.toBeNull()
  })

  it('deny: PENDING → DENIED', async () => {
    const { pendingId } = await createAskPending()
    const res = await app.inject({ method: 'POST', url: `/api/decisions/${pendingId}/deny`, payload: {} })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).status).toBe('DENIED')
  })

  it('repeated approve is idempotent (terminal no-op)', async () => {
    const { pendingId } = await createAskPending()
    const first = await app.inject({ method: 'POST', url: `/api/decisions/${pendingId}/approve`, payload: {} })
    const again = await app.inject({ method: 'POST', url: `/api/decisions/${pendingId}/approve`, payload: {} })
    expect(JSON.parse(again.payload).status).toBe('APPROVED')
    expect(JSON.parse(again.payload).resolvedAt).toBe(JSON.parse(first.payload).resolvedAt)
    const row = await prisma.ruleDecision.findUnique({ where: { id: pendingId } })
    expect(row?.resolvedBy).toBe(JSON.parse(first.payload).resolvedBy)
  })

  it('repeated deny is idempotent', async () => {
    const { pendingId } = await createAskPending()
    const first = await app.inject({ method: 'POST', url: `/api/decisions/${pendingId}/deny`, payload: {} })
    const again = await app.inject({ method: 'POST', url: `/api/decisions/${pendingId}/deny`, payload: {} })
    expect(JSON.parse(again.payload).status).toBe('DENIED')
    expect(JSON.parse(again.payload).resolvedAt).toBe(JSON.parse(first.payload).resolvedAt)
  })

  it('approve after DENIED does not reopen', async () => {
    const { pendingId } = await createAskPending()
    await app.inject({ method: 'POST', url: `/api/decisions/${pendingId}/deny`, payload: {} })
    const res = await app.inject({ method: 'POST', url: `/api/decisions/${pendingId}/approve`, payload: {} })
    expect(JSON.parse(res.payload).status).toBe('DENIED')
    const row = await prisma.ruleDecision.findUnique({ where: { id: pendingId } })
    expect(row?.status).toBe('DENIED')
    expect(row?.resolutionMethod).toBe('api')
  })

  it('deny after APPROVED does not reopen', async () => {
    const { pendingId } = await createAskPending()
    await app.inject({ method: 'POST', url: `/api/decisions/${pendingId}/approve`, payload: {} })
    const res = await app.inject({ method: 'POST', url: `/api/decisions/${pendingId}/deny`, payload: {} })
    expect(JSON.parse(res.payload).status).toBe('APPROVED')
    const row = await prisma.ruleDecision.findUnique({ where: { id: pendingId } })
    expect(row?.status).toBe('APPROVED')
    expect(row?.resolutionMethod).toBe('api')
  })

  it('resolution after EXPIRED does not reopen (never implicit DENY)', async () => {
    const { pendingId } = await createAskPending()
    await prisma.ruleDecision.update({ where: { id: pendingId }, data: { status: 'EXPIRED', resolutionMethod: 'timeout', resolvedAt: new Date() } })
    const res = await app.inject({ method: 'POST', url: `/api/decisions/${pendingId}/approve`, payload: {} })
    expect(JSON.parse(res.payload).status).toBe('EXPIRED')
    const row = await prisma.ruleDecision.findUnique({ where: { id: pendingId } })
    expect(row?.status).toBe('EXPIRED')
    expect(row?.resolutionMethod).toBe('timeout')
  })

  it('unknown pendingId → 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/decisions/no-such-id/approve', payload: {} })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/sessions/:sessionId/rule-decisions', () => {
  async function createAskPending() {
    const { sessionId, workspaceId } = await createSession()
    await prisma.rule.create({ data: { workspaceId, name: 'ask-prod', action: 'NOTIFY', decision: 'ASK', pathPattern: 'config/prod/**', message: 'Needs review' } })
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: { ...decisionBody(sessionId, 'config/prod/app.yaml'), pendingKey: `oc-${randSuffix()}` } })
    return { sessionId, pendingId: JSON.parse(res.payload).pendingId as string }
  }

  it('returns pending decision rows for a session', async () => {
    const { sessionId, pendingId } = await createAskPending()
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/rule-decisions` })
    expect(res.statusCode).toBe(200)
    const rows = JSON.parse(res.payload)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(pendingId)
    expect(rows[0].status).toBe('PENDING')
    expect(rows[0].verdict).toBe('ASK')
    expect(rows[0].ruleName).toBe('ask-prod')
  })

  it('returns approved/denied rows with lifecycle fields', async () => {
    const { sessionId, pendingId } = await createAskPending()
    await app.inject({ method: 'POST', url: `/api/decisions/${pendingId}/approve`, payload: {} })
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/rule-decisions` })
    const rows = JSON.parse(res.payload)
    expect(rows[0].status).toBe('APPROVED')
    expect(rows[0].resolutionMethod).toBe('api')
    expect(rows[0].resolvedAt).toBeTruthy()
  })

  it('lazily expires overdue PENDING decisions on read (never implicit DENY, broadcast decision_resolved)', async () => {
    const { sessionId, pendingId } = await createAskPending()
    await prisma.ruleDecision.update({ where: { id: pendingId }, data: { expiresAt: new Date(Date.now() - 5_000) } })
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/rule-decisions` })
    const rows = JSON.parse(res.payload)
    expect(rows[0].status).toBe('EXPIRED')
    expect(rows[0].resolutionMethod).toBe('timeout')
  })

  it('tolerates legacy Phase 3B rows (null status/pendingKey) in the same session listing', async () => {
    const { sessionId, workspaceId } = await createSession()
    await prisma.rule.create({ data: { workspaceId, name: 'deny-prod', action: 'NOTIFY', decision: 'DENY', pathPattern: 'config/prod/**' } })
    // legacy-style row created directly (no lifecycle fields)
    await prisma.ruleDecision.create({
      data: {
        ruleId: 'legacy-rule', workspaceId, sessionId, agentId: 'claude-1', connectorId: 'claude-code',
        tool: 'edit_file', path: 'config/prod/app.yaml', ruleName: 'deny-prod', verdict: 'DENY',
        matchedOn: { tool: null, pathPattern: 'config/prod/**', connectorId: null, agentPattern: null },
      },
    })
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/rule-decisions` })
    const rows = JSON.parse(res.payload)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBeNull()
    expect(rows[0].pendingKey).toBeNull()
  })

  it('returns rows ordered by createdAt desc, deterministic', async () => {
    const { sessionId, workspaceId } = await createSession()
    await prisma.rule.create({ data: { workspaceId, name: 'ask-1', action: 'NOTIFY', decision: 'ASK', pathPattern: 'config/**' } })
    await prisma.rule.create({ data: { workspaceId, name: 'ask-2', action: 'NOTIFY', decision: 'ASK', pathPattern: 'config/**' } })
    await app.inject({ method: 'POST', url: '/api/decisions', payload: { ...decisionBody(sessionId, 'config/a.yaml'), pendingKey: `k1-${randSuffix()}` } })
    // small delay so createdAt differs deterministically
    await new Promise((r) => setTimeout(r, 10))
    await app.inject({ method: 'POST', url: '/api/decisions', payload: { ...decisionBody(sessionId, 'config/b.yaml'), pendingKey: `k2-${randSuffix()}` } })
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/rule-decisions` })
    const rows = JSON.parse(res.payload)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i - 1].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(rows[i].createdAt).getTime())
    }
  })

  it('returns an empty array for a session with no decisions', async () => {
    const { sessionId } = await createSession()
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/rule-decisions` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual([])
  })
})

describe('decision lifecycle WebSocket emissions', () => {
  async function createAskPending() {
    const { sessionId, workspaceId } = await createSession()
    await prisma.rule.create({ data: { workspaceId, name: 'ask-prod', action: 'NOTIFY', decision: 'ASK', pathPattern: 'config/prod/**', message: 'Needs review' } })
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: { ...decisionBody(sessionId, 'config/prod/app.yaml'), pendingKey: `oc-${randSuffix()}` } })
    return { sessionId, pendingId: JSON.parse(res.payload).pendingId as string }
  }

  it('pending creation emits decision_pending', async () => {
    const spy = vi.spyOn(app.wsManager, 'broadcastDecisionPending')
    const { pendingId } = await createAskPending()
    expect(spy).toHaveBeenCalledTimes(1)
    expect((spy.mock.calls[0][1] as { pendingId: string }).pendingId).toBe(pendingId)
    spy.mockRestore()
  })

  it('approval emits decision_resolved; duplicate approve emits nothing extra', async () => {
    const spy = vi.spyOn(app.wsManager, 'broadcastDecisionResolved')
    const { pendingId } = await createAskPending()
    await app.inject({ method: 'POST', url: `/api/decisions/${pendingId}/approve`, payload: {} })
    expect(spy).toHaveBeenCalledTimes(1)
    expect((spy.mock.calls[0][1] as { status: string }).status).toBe('APPROVED')
    await app.inject({ method: 'POST', url: `/api/decisions/${pendingId}/approve`, payload: {} })
    expect(spy).toHaveBeenCalledTimes(1) // idempotent — no duplicate broadcast
    spy.mockRestore()
  })

  it('denial emits decision_resolved DENIED', async () => {
    const spy = vi.spyOn(app.wsManager, 'broadcastDecisionResolved')
    const { pendingId } = await createAskPending()
    await app.inject({ method: 'POST', url: `/api/decisions/${pendingId}/deny`, payload: {} })
    expect(spy).toHaveBeenCalledTimes(1)
    expect((spy.mock.calls[0][1] as { status: string }).status).toBe('DENIED')
    spy.mockRestore()
  })

  it('lazy expiration emits decision_resolved EXPIRED', async () => {
    const spy = vi.spyOn(app.wsManager, 'broadcastDecisionResolved')
    const { sessionId, pendingId } = await createAskPending()
    await prisma.ruleDecision.update({ where: { id: pendingId }, data: { expiresAt: new Date(Date.now() - 5_000) } })
    await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/rule-decisions` })
    expect(spy).toHaveBeenCalledTimes(1)
    expect((spy.mock.calls[0][1] as { status: string }).status).toBe('EXPIRED')
    spy.mockRestore()
  })

  it('delivery-failure marked decision is surfaced as EXPIRED on read (idempotent, no spurious broadcast)', async () => {
    const { markDeliveryFailure } = await import('../../services/pending-decision-service.js')
    const spy = vi.spyOn(app.wsManager, 'broadcastDecisionResolved')
    const { sessionId, pendingId } = await createAskPending()
    await markDeliveryFailure(app.prisma, pendingId)
    await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/rule-decisions` })
    // row is already EXPIRED via delivery_failure; sweep leaves it terminal
    const row = await prisma.ruleDecision.findUnique({ where: { id: pendingId } })
    expect(row?.status).toBe('EXPIRED')
    expect(row?.resolutionMethod).toBe('delivery_failure')
    // lazy sweep does not re-broadcast an already-terminal row (idempotent)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})