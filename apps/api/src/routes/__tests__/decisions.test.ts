import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
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