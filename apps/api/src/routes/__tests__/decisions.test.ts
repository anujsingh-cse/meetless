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