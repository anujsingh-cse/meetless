import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildApp } from '../app.js'
import { prisma } from '@meetless/database/client'

let app: Awaited<ReturnType<typeof buildApp>>

const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0 })
})

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

async function seed() {
  const team = await prisma.team.create({ data: { name: `T-${randSuffix()}`, slug: `t-${randSuffix()}` } })
  const user = await prisma.user.create({ data: { clerkId: `c-${randSuffix()}`, email: `e-${randSuffix()}@ex.com` } })
  const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'W' } })
  const session = await prisma.session.create({ data: { workspaceId: workspace.id, userId: user.id, name: 'E2E' } })
  await prisma.connector.upsert({ where: { id: 'claude-code' }, update: {}, create: { id: 'claude-code', name: 'claude-code', version: '1.0.0', capabilities: {} } })
  return { workspaceId: workspace.id, sessionId: session.id }
}

function pending(sessionId: string, path: string) {
  return { sessionId, agentId: 'claude-1', connectorId: 'claude-code', tool: 'edit_file', params: { path, content: 'x' } }
}

describe('Prevention E2E', () => {
  it('denies a pending call against a DENY rule, audits it, and never ingests it', async () => {
    const { workspaceId, sessionId } = await seed()
    const rule = await prisma.rule.create({ data: { workspaceId, name: 'deny-prod', action: 'NOTIFY', decision: 'DENY', pathPattern: 'config/prod/**', message: 'off-limits' } })

    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: pending(sessionId, 'config/prod/app.yaml') })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.decision).toBe('deny')
    expect(body.ruleId).toBe(rule.id)
    expect(body.reason).toBe('off-limits')

    const decision = await prisma.ruleDecision.findFirst({ where: { sessionId } })
    expect(decision).not.toBeNull()
    expect(decision?.verdict).toBe('DENY')
    expect(await prisma.normalizedEvent.count({ where: { sessionId } })).toBe(0)
    expect(await prisma.conflict.count({ where: { sessionId } })).toBe(0)
    expect(await prisma.ruleHit.count({ where: { sessionId } })).toBe(0)
  })

  it('allows a non-matching pending call with no audit row', async () => {
    const { workspaceId, sessionId } = await seed()
    await prisma.rule.create({ data: { workspaceId, name: 'deny-prod', action: 'NOTIFY', decision: 'DENY', pathPattern: 'config/prod/**' } })
    const res = await app.inject({ method: 'POST', url: '/api/decisions', payload: pending(sessionId, 'src/app.ts') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ decision: 'allow' })
    expect(await prisma.ruleDecision.count({ where: { sessionId } })).toBe(0)
  })

  it('allowed flows still reconcile: conflicting edits with an active DENY rule still produce a conflict', async () => {
    const { workspaceId, sessionId } = await seed()
    await prisma.rule.create({ data: { workspaceId, name: 'watch-src', action: 'NOTIFY', decision: 'DENY', pathPattern: 'src/**' } })
    await prisma.connector.upsert({ where: { id: 'cursor-hooks' }, update: {}, create: { id: 'cursor-hooks', name: 'cursor-hooks', version: '1.0.0', capabilities: {} } })

    const e1 = await app.inject({ method: 'POST', url: '/api/events', payload: { sessionId, agentId: 'claude-1', tool: 'edit_file', params: { path: 'src/app.ts', content: 'a' }, result: { success: true }, connectorId: 'claude-code', connectorVersion: '1.0.0', mcpEventId: `m-${randSuffix()}` } })
    const e2 = await app.inject({ method: 'POST', url: '/api/events', payload: { sessionId, agentId: 'cursor-1', tool: 'edit_file', params: { path: 'src/app.ts', content: 'b' }, result: { success: true }, connectorId: 'cursor-hooks', connectorVersion: '1.0.0', mcpEventId: `m-${randSuffix()}` } })
    expect(e1.statusCode).toBe(201)
    expect(e2.statusCode).toBe(201)

    const conflicts = await prisma.conflict.findMany({ where: { sessionId } })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].status).toBe('PENDING')
    // ruleHit rows come only from the ingestion path (NOTIFY on src/**), never from decisions
    expect(await prisma.ruleHit.count({ where: { sessionId } })).toBe(2)
    expect(await prisma.ruleDecision.count({ where: { sessionId } })).toBe(0)
  })
})