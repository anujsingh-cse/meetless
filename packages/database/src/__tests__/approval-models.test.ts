import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'

const prisma = new PrismaClient()

beforeAll(async () => { await prisma.$connect() })
afterAll(async () => { await prisma.$disconnect() })

describe('Approval / ASK RuleDecision model', () => {
  it('persists an ASK RuleDecision with lifecycle fields and survives Rule deletion', async () => {
    const team = await prisma.team.create({ data: { name: 'Ask Team', slug: `ask-${randomUUID()}` } })
    const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'Ask WS' } })

    const rule = await prisma.rule.create({
      data: {
        workspaceId: workspace.id,
        name: 'Review contracts',
        action: 'NOTIFY',
        pathPattern: 'contracts/**',
        decision: 'ASK',
        message: 'Needs human review',
      },
    })
    expect(rule.decision).toBe('ASK')

    const expiresAt = new Date(Date.now() + 60_000)
    const decision = await prisma.ruleDecision.create({
      data: {
        ruleId: rule.id,
        workspaceId: workspace.id,
        sessionId: 'any-session',
        agentId: 'opencode-1',
        connectorId: 'opencode',
        tool: 'edit_file',
        path: 'contracts/api.yaml',
        ruleName: rule.name,
        verdict: 'ASK',
        matchedOn: { tool: null, pathPattern: 'contracts/**', connectorId: null, agentPattern: null },
        message: rule.message,
        status: 'PENDING',
        pendingKey: 'oc-request-1',
        expiresAt,
      },
    })
    expect(decision.verdict).toBe('ASK')
    expect(decision.status).toBe('PENDING')
    expect(decision.pendingKey).toBe('oc-request-1')
    expect(decision.expiresAt?.toISOString()).toBe(expiresAt.toISOString())
    expect(decision.resolvedAt).toBeNull()
    expect(decision.resolvedBy).toBeNull()
    expect(decision.resolutionMethod).toBeNull()

    // Delete the Rule; the scalar RuleDecision must survive (no FK relation).
    await prisma.rule.delete({ where: { id: rule.id } })
    const surviving = await prisma.ruleDecision.findUnique({ where: { id: decision.id } })
    expect(surviving).not.toBeNull()
    expect(surviving?.ruleId).toBe(rule.id)
    expect(surviving?.ruleName).toBe('Review contracts')
    expect(surviving?.status).toBe('PENDING')

    // cleanup
    await prisma.ruleDecision.deleteMany({})
    await prisma.workspace.delete({ where: { id: workspace.id } })
    await prisma.team.delete({ where: { id: team.id } })
  })

  it('preserves legacy allow/deny RuleDecision rows with null status and null pendingKey', async () => {
    const team = await prisma.team.create({ data: { name: 'Legacy Team', slug: `legacy-${randomUUID()}` } })
    const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'Legacy WS' } })

    const rule = await prisma.rule.create({
      data: {
        workspaceId: workspace.id,
        name: 'Block prod',
        action: 'NOTIFY',
        pathPattern: 'config/prod/**',
        decision: 'DENY',
      },
    })

    // A legacy Phase 3B-style row: no status, no pendingKey, no lifecycle fields.
    const legacy = await prisma.ruleDecision.create({
      data: {
        ruleId: rule.id,
        workspaceId: workspace.id,
        sessionId: 'legacy-session',
        agentId: 'claude-1',
        connectorId: 'claude-code',
        tool: 'edit_file',
        path: 'config/prod/app.yaml',
        ruleName: rule.name,
        verdict: 'DENY',
        matchedOn: { tool: null, pathPattern: 'config/prod/**', connectorId: null, agentPattern: null },
      },
    })
    expect(legacy.status).toBeNull()
    expect(legacy.pendingKey).toBeNull()
    expect(legacy.expiresAt).toBeNull()
    expect(legacy.resolvedAt).toBeNull()
    expect(legacy.resolutionMethod).toBeNull()

    // Two legacy rows with null pendingKey coexist without uniqueness collision.
    await prisma.ruleDecision.create({
      data: {
        ruleId: rule.id,
        workspaceId: workspace.id,
        sessionId: 'legacy-session-2',
        agentId: 'claude-2',
        connectorId: 'claude-code',
        tool: 'edit_file',
        path: 'config/prod/app.yaml',
        ruleName: rule.name,
        verdict: 'DENY',
        matchedOn: { tool: null, pathPattern: 'config/prod/**', connectorId: null, agentPattern: null },
      },
    })
    const count = await prisma.ruleDecision.count({ where: { workspaceId: workspace.id } })
    expect(count).toBe(2)

    // cleanup
    await prisma.ruleDecision.deleteMany({})
    await prisma.workspace.delete({ where: { id: workspace.id } })
    await prisma.team.delete({ where: { id: team.id } })
  })
})