import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildApp } from '../../app.js'
import { prisma } from '@meetless/database/client'

let app: Awaited<ReturnType<typeof buildApp>>

const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function createWorkspace() {
  const team = await prisma.team.create({ data: { name: `T-${randSuffix()}`, slug: `t-${randSuffix()}` } })
  return prisma.workspace.create({ data: { teamId: team.id, name: `W-${randSuffix()}` } })
}

const validRuleBody = (workspaceId: string) => ({
  workspaceId,
  name: 'Protect prod',
  action: 'NOTIFY',
  pathPattern: 'config/prod/**',
  message: 'off-limits',
})

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

beforeEach(async () => {
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

describe('POST /api/rules', () => {
  it('creates a rule', async () => {
    const ws = await createWorkspace()
    const res = await app.inject({ method: 'POST', url: '/api/rules', payload: validRuleBody(ws.id) })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)
    expect(body.action).toBe('NOTIFY')
    expect(body.enabled).toBe(true)
    expect(body.priority).toBe(100)
    expect(body.pathPattern).toBe('config/prod/**')
  })
  it('rejects a rule with zero constraints', async () => {
    const ws = await createWorkspace()
    const res = await app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: { workspaceId: ws.id, name: 'match-all', action: 'LOG', tool: '   ' },
    })
    expect(res.statusCode).toBe(400)
  })
  it('rejects an invalid path glob', async () => {
    const ws = await createWorkspace()
    const res = await app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: { ...validRuleBody(ws.id), pathPattern: 'config(prod/**' },
    })
    expect(res.statusCode).toBe(400)
  })
  it('rejects an unknown workspaceId', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/rules', payload: validRuleBody('nope') })
    expect(res.statusCode).toBe(400)
  })
  it('rejects an invalid action via schema enum', async () => {
    const ws = await createWorkspace()
    const res = await app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: { ...validRuleBody(ws.id), action: 'PREVENT' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /api/rules', () => {
  it('lists rules for a workspace ordered by priority asc', async () => {
    const ws = await createWorkspace()
    await prisma.rule.createMany({
      data: [
        { workspaceId: ws.id, name: 'a', action: 'LOG', priority: 100, pathPattern: 'a/**' },
        { workspaceId: ws.id, name: 'b', action: 'NOTIFY', priority: 10, pathPattern: 'b/**' },
      ],
    })
    const res = await app.inject({ method: 'GET', url: `/api/rules?workspaceId=${ws.id}` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.map((r: { name: string }) => r.name)).toEqual(['b', 'a'])
  })
  it('rejects a missing workspaceId query', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/rules' })
    expect(res.statusCode).toBe(400)
  })
})

describe('PATCH /api/rules/:id', () => {
  it('updates fields and can disable a rule', async () => {
    const ws = await createWorkspace()
    const rule = await prisma.rule.create({ data: { workspaceId: ws.id, name: 'r', action: 'LOG', pathPattern: 'a/**' } })
    const res = await app.inject({ method: 'PATCH', url: `/api/rules/${rule.id}`, payload: { enabled: false, message: 'new' } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.enabled).toBe(false)
    expect(body.message).toBe('new')
  })
  it('rejects an update that leaves zero constraints', async () => {
    const ws = await createWorkspace()
    const rule = await prisma.rule.create({ data: { workspaceId: ws.id, name: 'r', action: 'LOG', pathPattern: 'a/**' } })
    const res = await app.inject({ method: 'PATCH', url: `/api/rules/${rule.id}`, payload: { pathPattern: null, tool: null, connectorId: null, agentPattern: null } })
    expect(res.statusCode).toBe(400)
  })
  it('returns 404 for an unknown rule', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/rules/does-not-exist', payload: { enabled: false } })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /api/rules/:id', () => {
  it('deletes a rule and returns its id', async () => {
    const ws = await createWorkspace()
    const rule = await prisma.rule.create({ data: { workspaceId: ws.id, name: 'r', action: 'LOG', pathPattern: 'a/**' } })
    const res = await app.inject({ method: 'DELETE', url: `/api/rules/${rule.id}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).id).toBe(rule.id)
    expect(await prisma.rule.findUnique({ where: { id: rule.id } })).toBeNull()
  })
  it('returns 404 for an unknown rule', async () => {
    const ws = await createWorkspace()
    await prisma.rule.create({ data: { workspaceId: ws.id, name: 'r', action: 'LOG', pathPattern: 'a/**' } })
    const res = await app.inject({ method: 'DELETE', url: '/api/rules/does-not-exist' })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/sessions/:sessionId/rule-hits', () => {
  it('returns hits for a session ordered by createdAt desc with matchedOn shape', async () => {
    const ws = await createWorkspace()
    const rule = await prisma.rule.create({ data: { workspaceId: ws.id, name: 'r', action: 'NOTIFY', pathPattern: 'a/**' } })
    await prisma.ruleHit.createMany({
      data: [
        { ruleId: rule.id, workspaceId: ws.id, sessionId: 's1', agentId: 'a', connectorId: 'c', tool: 't', path: 'a/x', ruleName: 'r', action: 'NOTIFY', matchedOn: { tool: null, pathPattern: 'a/**', connectorId: null, agentPattern: null }, message: 'm', createdAt: new Date('2026-01-02T00:00:00Z') },
        { ruleId: rule.id, workspaceId: ws.id, sessionId: 's1', agentId: 'a', connectorId: 'c', tool: 't', path: 'a/x', ruleName: 'r', action: 'NOTIFY', matchedOn: { tool: null, pathPattern: 'a/**', connectorId: null, agentPattern: null }, message: 'm', createdAt: new Date('2026-01-01T00:00:00Z') },
      ],
    })
    const res = await app.inject({ method: 'GET', url: '/api/sessions/s1/rule-hits' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body).toHaveLength(2)
    expect(body[0].createdAt).toBe('2026-01-02T00:00:00.000Z')
    expect(body[0].matchedOn).toEqual({ tool: null, pathPattern: 'a/**', connectorId: null, agentPattern: null })
  })
})

describe('rule decision field', () => {
  it('creates a rule with a DENY decision', async () => {
    const ws = await createWorkspace()
    const res = await app.inject({ method: 'POST', url: '/api/rules', payload: { ...validRuleBody(ws.id), decision: 'DENY' } })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)
    expect(body.decision).toBe('DENY')
    expect(body.action).toBe('NOTIFY') // RuleAction unchanged
  })

  it('serializes decision as null when not provided', async () => {
    const ws = await createWorkspace()
    const res = await app.inject({ method: 'POST', url: '/api/rules', payload: validRuleBody(ws.id) })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.payload).decision).toBeNull()
  })

  it('rejects an invalid decision enum value', async () => {
    const ws = await createWorkspace()
    const res = await app.inject({ method: 'POST', url: '/api/rules', payload: { ...validRuleBody(ws.id), decision: 'BLOCK' } })
    expect(res.statusCode).toBe(400)
  })

  it('updates the decision field via PATCH', async () => {
    const ws = await createWorkspace()
    const rule = await prisma.rule.create({ data: { workspaceId: ws.id, name: 'r', action: 'LOG', pathPattern: 'a/**' } })
    const res = await app.inject({ method: 'PATCH', url: `/api/rules/${rule.id}`, payload: { decision: 'DENY' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).decision).toBe('DENY')
  })

  it('can clear the decision field via PATCH', async () => {
    const ws = await createWorkspace()
    const rule = await prisma.rule.create({ data: { workspaceId: ws.id, name: 'r', action: 'LOG', pathPattern: 'a/**', decision: 'DENY' } })
    const res = await app.inject({ method: 'PATCH', url: `/api/rules/${rule.id}`, payload: { decision: null } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).decision).toBeNull()
  })
})
