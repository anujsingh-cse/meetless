import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '@meetless/database/client'
import {
  ASK_EXPIRY_MS,
  createPendingDecision,
  resolvePending,
  expireIfNeeded,
  markDeliveryFailure,
  listSessionDecisions,
} from '../pending-decision-service.js'
import type { CreatePendingInput } from '../pending-decision-service.js'

const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const makeInput = (over: Partial<CreatePendingInput> = {}): CreatePendingInput => ({
  workspaceId: `ws-${randSuffix()}`,
  sessionId: `sess-${randSuffix()}`,
  agentId: 'opencode-1',
  connectorId: 'opencode',
  tool: 'edit_file',
  path: 'contracts/api.yaml',
  ruleId: 'rule-1',
  ruleName: 'Review contracts',
  verdict: 'ASK',
  matchedOn: { tool: null, pathPattern: 'contracts/**', connectorId: null, agentPattern: null },
  message: 'Needs human review',
  pendingKey: `req-${randSuffix()}`,
  ...over,
})

beforeEach(async () => {
  await prisma.ruleDecision.deleteMany()
})

describe('createPendingDecision', () => {
  it('creates exactly one PENDING decision with expiry set', async () => {
    const before = Date.now()
    const res = await createPendingDecision(prisma, makeInput())
    expect(res.created).toBe(true)
    expect(res.pendingId).toMatch(/./)

    const row = await prisma.ruleDecision.findUnique({ where: { id: res.pendingId } })
    expect(row?.status).toBe('PENDING')
    expect(row?.verdict).toBe('ASK')
    expect(row?.expiresAt).not.toBeNull()
    const expiresDelta = row!.expiresAt!.getTime() - before
    expect(expiresDelta).toBeGreaterThan(0)
    // expiresAt = creationTime + ASK_EXPIRY_MS; allow small timing slack after `before`
    expect(expiresDelta).toBeLessThanOrEqual(ASK_EXPIRY_MS + 1000)

    const count = await prisma.ruleDecision.count({ where: { pendingKey: row!.pendingKey } })
    expect(count).toBe(1)
  })

  it('returns the same pending decision on an identical retry (no duplicate row)', async () => {
    const input = makeInput()
    const first = await createPendingDecision(prisma, input)
    const second = await createPendingDecision(prisma, input)
    expect(second.pendingId).toBe(first.pendingId)
    expect(second.created).toBe(false)
    const rows = await prisma.ruleDecision.findMany({ where: { pendingKey: input.pendingKey } })
    expect(rows).toHaveLength(1)
  })

  it('does not collide across different connector/session/pendingKey', async () => {
    const input = makeInput()
    const a = await createPendingDecision(prisma, input)
    const b = await createPendingDecision(prisma, { ...input, sessionId: `sess-${randSuffix()}` })
    const c = await createPendingDecision(prisma, { ...input, connectorId: 'claude-code' })
    const d = await createPendingDecision(prisma, { ...input, pendingKey: `req-${randSuffix()}` })
    expect(new Set([a.pendingId, b.pendingId, c.pendingId, d.pendingId]).size).toBe(4)
  })

  it('concurrent identical creation does not create duplicate logical requests', async () => {
    const input = makeInput()
    const [a, b, c] = await Promise.all([
      createPendingDecision(prisma, input),
      createPendingDecision(prisma, input),
      createPendingDecision(prisma, input),
    ])
    expect(new Set([a.pendingId, b.pendingId, c.pendingId]).size).toBe(1)
    const count = await prisma.ruleDecision.count({ where: { pendingKey: input.pendingKey } })
    expect(count).toBe(1)
  })
})

describe('resolvePending', () => {
  it('approve: PENDING to APPROVED with resolution metadata', async () => {
    const created = await createPendingDecision(prisma, makeInput())
    const res = await resolvePending(prisma, created.pendingId, 'APPROVED', 'alice', 'api')
    expect(res?.changed).toBe(true)
    expect(res?.status).toBe('APPROVED')
    const row = await prisma.ruleDecision.findUnique({ where: { id: created.pendingId } })
    expect(row?.status).toBe('APPROVED')
    expect(row?.resolvedAt).not.toBeNull()
    expect(row?.resolvedBy).toBe('alice')
    expect(row?.resolutionMethod).toBe('api')
  })

  it('deny: PENDING to DENIED', async () => {
    const created = await createPendingDecision(prisma, makeInput())
    const res = await resolvePending(prisma, created.pendingId, 'DENIED', 'alice', 'api')
    expect(res?.changed).toBe(true)
    expect(res?.status).toBe('DENIED')
  })

  it('idempotent: approve after APPROVED is a deterministic no-op', async () => {
    const created = await createPendingDecision(prisma, makeInput())
    await resolvePending(prisma, created.pendingId, 'APPROVED', 'alice', 'api')
    const again = await resolvePending(prisma, created.pendingId, 'APPROVED', 'alice', 'api')
    expect(again?.changed).toBe(false)
    expect(again?.status).toBe('APPROVED')
  })

  it('idempotent: deny after DENIED is a deterministic no-op', async () => {
    const created = await createPendingDecision(prisma, makeInput())
    await resolvePending(prisma, created.pendingId, 'DENIED', 'alice', 'api')
    const again = await resolvePending(prisma, created.pendingId, 'DENIED', 'alice', 'api')
    expect(again?.changed).toBe(false)
    expect(again?.status).toBe('DENIED')
  })

  it('does not reopen: approve after DENIED', async () => {
    const created = await createPendingDecision(prisma, makeInput())
    await resolvePending(prisma, created.pendingId, 'DENIED', 'alice', 'api')
    const res = await resolvePending(prisma, created.pendingId, 'APPROVED', 'bob', 'api')
    expect(res?.changed).toBe(false)
    expect(res?.status).toBe('DENIED')
  })

  it('does not reopen: deny after APPROVED', async () => {
    const created = await createPendingDecision(prisma, makeInput())
    await resolvePending(prisma, created.pendingId, 'APPROVED', 'alice', 'api')
    const res = await resolvePending(prisma, created.pendingId, 'DENIED', 'bob', 'api')
    expect(res?.changed).toBe(false)
    expect(res?.status).toBe('APPROVED')
  })

  it('compare-and-set: exactly one of two conflicting terminal transitions wins', async () => {
    const created = await createPendingDecision(prisma, makeInput())
    const [r1, r2] = await Promise.all([
      resolvePending(prisma, created.pendingId, 'APPROVED', 'a', 'api'),
      resolvePending(prisma, created.pendingId, 'DENIED', 'b', 'api'),
    ])
    const wins = [r1, r2].filter((r) => r?.changed)
    expect(wins).toHaveLength(1)
    const row = await prisma.ruleDecision.findUnique({ where: { id: created.pendingId } })
    expect(['APPROVED', 'DENIED']).toContain(row?.status)
  })

  it('returns null for an unknown pendingId', async () => {
    const res = await resolvePending(prisma, 'no-such-id', 'APPROVED', 'alice', 'api')
    expect(res).toBeNull()
  })
})

describe('expireIfNeeded', () => {
  it('marks an overdue PENDING decision EXPIRED with method timeout', async () => {
    const created = await createPendingDecision(prisma, makeInput({ expiresAt: new Date(Date.now() - 1000) }))
    const row = await expireIfNeeded(prisma, created.pendingId)
    expect(row?.status).toBe('EXPIRED')
    expect(row?.resolutionMethod).toBe('timeout')
    expect(row?.resolvedAt).not.toBeNull()
  })

  it('does not expire a terminal decision', async () => {
    const created = await createPendingDecision(prisma, makeInput({ expiresAt: new Date(Date.now() - 1000) }))
    await resolvePending(prisma, created.pendingId, 'APPROVED', 'alice', 'api')
    const row = await expireIfNeeded(prisma, created.pendingId)
    expect(row?.status).toBe('APPROVED')
    expect(row?.resolutionMethod).toBe('api')
  })

  it('does not mark EXPIRED as DENY (no implicit DENY on expiry)', async () => {
    const created = await createPendingDecision(prisma, makeInput({ expiresAt: new Date(Date.now() - 1000) }))
    const row = await expireIfNeeded(prisma, created.pendingId)
    expect(row?.status).toBe('EXPIRED')
    expect(row!.status).not.toBe('DENIED')
  })
})

describe('markDeliveryFailure', () => {
  it('marks an open PENDING EXPIRED with method delivery_failure', async () => {
    const created = await createPendingDecision(prisma, makeInput())
    const row = await markDeliveryFailure(prisma, created.pendingId)
    expect(row?.status).toBe('EXPIRED')
    expect(row?.resolutionMethod).toBe('delivery_failure')
  })

  it('is a no-op for terminal decisions', async () => {
    const created = await createPendingDecision(prisma, makeInput())
    await resolvePending(prisma, created.pendingId, 'APPROVED', 'alice', 'api')
    const row = await markDeliveryFailure(prisma, created.pendingId)
    expect(row?.status).toBe('APPROVED')
    expect(row?.resolutionMethod).toBe('api')
  })
})

describe('resolution after EXPIRED', () => {
  it('does not reopen an expired decision', async () => {
    const created = await createPendingDecision(prisma, makeInput({ expiresAt: new Date(Date.now() - 1000) }))
    await expireIfNeeded(prisma, created.pendingId)
    const res = await resolvePending(prisma, created.pendingId, 'APPROVED', 'alice', 'api')
    expect(res?.changed).toBe(false)
    expect(res?.status).toBe('EXPIRED')
  })
})

describe('legacy compatibility', () => {
  it('legacy Phase 3B rows (null status) remain readable via listing', async () => {
    const created = await createPendingDecision(prisma, makeInput())
    await prisma.ruleDecision.create({
      data: {
        ruleId: 'legacy-rule', workspaceId: 'w', sessionId: 'legacy-sess',
        agentId: 'a', connectorId: 'claude-code', tool: 'edit_file', path: 'x',
        ruleName: 'legacy', verdict: 'DENY',
        matchedOn: { tool: null, pathPattern: null, connectorId: null, agentPattern: null },
        createdAt: new Date(Date.now() - 1000),
      },
    })
    // The legacy row must be readable and unchanged by lifecycle operations
    const legacy = await prisma.ruleDecision.findFirst({ where: { sessionId: 'legacy-sess' } })
    expect(legacy?.status).toBeNull()
    expect(legacy?.verdict).toBe('DENY')

    const rows = await listSessionDecisions(prisma, 'legacy-sess')
    expect(rows).toHaveLength(1)
    expect(rows[0].verdict).toBe('DENY')

    // Creating a pending in another session is unaffected by legacy rows
    expect((await prisma.ruleDecision.findUnique({ where: { id: created.pendingId } }))?.status).toBe('PENDING')
  })
})

describe('listSessionDecisions', () => {
  it('returns decisions ordered by createdAt desc with cap', async () => {
    const sessionId = `sess-${randSuffix()}`
    await createPendingDecision(prisma, makeInput({ sessionId }))
    await createPendingDecision(prisma, makeInput({ sessionId, pendingKey: `req-${randSuffix()}` }))
    const rows = await listSessionDecisions(prisma, sessionId)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.sessionId === sessionId)).toBe(true)
  })
})
