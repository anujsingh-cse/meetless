import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'

const prisma = new PrismaClient()

beforeAll(async () => { await prisma.$connect() })
afterAll(async () => { await prisma.$disconnect() })

describe('RuleDecision audit model', () => {
  it('persists Rule.decision, records a RuleDecision, and survives Rule deletion', async () => {
    const team = await prisma.team.create({ data: { name: 'Dec Team', slug: `dec-${randomUUID()}` } })
    const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'Dec WS' } })

    const rule = await prisma.rule.create({
      data: {
        workspaceId: workspace.id,
        name: 'Block prod config',
        action: 'NOTIFY',
        pathPattern: 'config/prod/**',
        decision: 'DENY',
        message: 'Prod config is off-limits',
      },
    })
    expect(rule.decision).toBe('DENY')

    const decision = await prisma.ruleDecision.create({
      data: {
        ruleId: rule.id,
        workspaceId: workspace.id,
        sessionId: 'any-session',
        agentId: 'claude-1',
        connectorId: 'claude-code',
        tool: 'edit_file',
        path: 'config/prod/app.yaml',
        ruleName: rule.name,
        verdict: 'DENY',
        matchedOn: { tool: null, pathPattern: 'config/prod/**', connectorId: null, agentPattern: null },
        message: rule.message,
      },
    })
    expect(decision.verdict).toBe('DENY')
    expect(decision.matchedOn).toMatchObject({ pathPattern: 'config/prod/**' })

    // Delete the Rule; the scalar RuleDecision must survive (no FK relation).
    await prisma.rule.delete({ where: { id: rule.id } })
    const surviving = await prisma.ruleDecision.findUnique({ where: { id: decision.id } })
    expect(surviving).not.toBeNull()
    expect(surviving?.ruleId).toBe(rule.id)
    expect(surviving?.ruleName).toBe('Block prod config')

    // cleanup
    await prisma.ruleDecision.deleteMany({})
    await prisma.workspace.delete({ where: { id: workspace.id } })
    await prisma.team.delete({ where: { id: team.id } })
  })
})