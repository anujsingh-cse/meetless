import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'

const prisma = new PrismaClient()

beforeAll(async () => {
  await prisma.$connect()
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('Rule / RuleHit models', () => {
  it('persists a Rule scoped to a workspace and a scalar RuleHit that survives Rule deletion', async () => {
    const team = await prisma.team.create({ data: { name: 'Rules Team', slug: `rules-${randomUUID()}` } })
    const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'Rules WS' } })

    const rule = await prisma.rule.create({
      data: {
        workspaceId: workspace.id,
        name: 'Protect prod config',
        tool: null,
        pathPattern: 'config/prod/**',
        connectorId: null,
        agentPattern: null,
        action: 'NOTIFY',
        message: 'Prod config is off-limits',
        priority: 10,
      },
    })
    expect(rule.workspaceId).toBe(workspace.id)
    expect(rule.enabled).toBe(true)

    const hit = await prisma.ruleHit.create({
      data: {
        ruleId: rule.id,
        workspaceId: workspace.id,
        sessionId: 'any-session',
        agentId: 'claude-1',
        connectorId: 'claude-code',
        tool: 'edit_file',
        path: 'config/prod/app.yaml',
        ruleName: rule.name,
        action: rule.action,
        matchedOn: { tool: null, pathPattern: 'config/prod/**', connectorId: null, agentPattern: null },
        message: rule.message,
      },
    })
    expect(hit.ruleId).toBe(rule.id)
    expect(hit.matchedOn).toMatchObject({ pathPattern: 'config/prod/**' })

    // Delete the Rule; the scalar RuleHit must survive (no FK relation).
    await prisma.rule.delete({ where: { id: rule.id } })
    const surviving = await prisma.ruleHit.findUnique({ where: { id: hit.id } })
    expect(surviving).not.toBeNull()
    expect(surviving?.ruleId).toBe(rule.id)
    expect(surviving?.ruleName).toBe('Protect prod config')

    // cleanup
    await prisma.ruleHit.deleteMany({})
    await prisma.workspace.delete({ where: { id: workspace.id } })
    await prisma.team.delete({ where: { id: team.id } })
  })
})
