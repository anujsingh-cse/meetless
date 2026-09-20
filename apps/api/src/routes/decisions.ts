import { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { decide } from '../services/decision-service.js'
import { createPendingDecision, resolvePending, expireIfNeeded, listSessionDecisions } from '../services/pending-decision-service.js'

interface DecisionBody {
  sessionId: string
  agentId: string
  connectorId: string
  tool: string
  params: Record<string, unknown>
  pendingKey?: string
}

const decisionBodySchema = {
  type: 'object',
  required: ['sessionId', 'agentId', 'connectorId', 'tool', 'params'],
  properties: {
    sessionId: { type: 'string' },
    agentId: { type: 'string' },
    connectorId: { type: 'string' },
    tool: { type: 'string' },
    params: { type: 'object', additionalProperties: true },
    pendingKey: { type: 'string' },
  },
} as const

const ruleDecisionResponseSchema = {
  type: 'object',
  required: ['id', 'sessionId', 'verdict'],
  properties: {
    id: { type: 'string' },
    sessionId: { type: 'string' },
    workspaceId: { type: 'string' },
    agentId: { type: 'string' },
    connectorId: { type: 'string' },
    tool: { type: 'string' },
    path: { type: ['string', 'null'] },
    ruleId: { type: 'string' },
    ruleName: { type: 'string' },
    verdict: { type: 'string', enum: ['ALLOW', 'DENY', 'ASK'] },
    matchedOn: { type: 'object', additionalProperties: true },
    message: { type: ['string', 'null'] },
    status: { type: ['string', 'null'] },
    pendingKey: { type: ['string', 'null'] },
    expiresAt: { type: ['string', 'null'], format: 'date-time' },
    resolvedAt: { type: ['string', 'null'], format: 'date-time' },
    resolvedBy: { type: ['string', 'null'] },
    resolutionMethod: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const

const decisionResponseSchema = {
  type: 'object',
  required: ['decision'],
  properties: {
    decision: { type: 'string', enum: ['allow', 'deny', 'ask'] },
    ruleId: { type: 'string' },
    ruleName: { type: 'string' },
    matchedOn: { type: 'object', additionalProperties: true },
    reason: { type: ['string', 'null'] },
    pendingId: { type: 'string' },
    expiresAt: { type: 'string', format: 'date-time' },
  },
} as const

const resolveParamsSchema = {
  type: 'object',
  required: ['pendingId'],
  properties: { pendingId: { type: 'string' } },
} as const

const resolutionBodySchema = {
  type: 'object',
  properties: {},
} as const

const resolutionResponseSchema = {
  type: 'object',
  required: ['pendingId', 'status'],
  properties: {
    pendingId: { type: 'string' },
    status: { type: 'string', enum: ['PENDING', 'APPROVED', 'DENIED', 'EXPIRED'] },
    resolvedAt: { type: ['string', 'null'], format: 'date-time' },
    resolvedBy: { type: ['string', 'null'] },
  },
} as const

const errorResponseSchema = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'string' } },
} as const

export const decisionRoutes: FastifyPluginAsync = async (app) => {
  app.post('/decisions', {
    schema: {
      body: decisionBodySchema,
      response: {
        200: decisionResponseSchema,
        400: errorResponseSchema,
      },
    },
  }, async (req, reply) => {
    const body = req.body as DecisionBody

    const session = await app.prisma.session.findUnique({ where: { id: body.sessionId } })
    if (!session) return reply.code(400).send({ error: 'Invalid sessionId' })

    try {
      const rules = await app.prisma.rule.findMany({
        where: { workspaceId: session.workspaceId, enabled: true },
      })

      const outcome = decide(
        { agentId: body.agentId, connectorId: body.connectorId, tool: body.tool, params: body.params },
        rules
      )

      // ASK: create a pending decision instead of an immediate verdict. Audit rows are
      // surfaced through the pending RuleDecision (status PENDING), not as terminal matches.
      if (outcome.decision === 'ask' && outcome.winning) {
        const pending = await createPendingDecision(app.prisma, {
          workspaceId: session.workspaceId,
          sessionId: body.sessionId,
          agentId: body.agentId,
          connectorId: body.connectorId,
          tool: body.tool,
          path: typeof body.params?.path === 'string' ? body.params.path : null,
          ruleId: outcome.winning.ruleId,
          ruleName: outcome.winning.ruleName,
          verdict: 'ASK',
          matchedOn: outcome.winning.matchedOn as unknown as Prisma.InputJsonValue,
          message: outcome.winning.message,
          pendingKey: body.pendingKey ?? randomUUID(),
        })
        app.wsManager.broadcastDecisionPending(body.sessionId, {
          pendingId: pending.pendingId,
          sessionId: body.sessionId,
          agentId: body.agentId,
          connectorId: body.connectorId,
          tool: body.tool,
          path: typeof body.params?.path === 'string' ? body.params.path : null,
          ruleId: outcome.winning.ruleId,
          ruleName: outcome.winning.ruleName,
          reason: outcome.reason ?? null,
          expiresAt: pending.expiresAt.toISOString(),
        })
        return {
          decision: 'ask',
          pendingId: pending.pendingId,
          ruleId: outcome.winning.ruleId,
          ruleName: outcome.winning.ruleName,
          reason: outcome.reason ?? null,
          expiresAt: pending.expiresAt.toISOString(),
        }
      }

      if (outcome.matches.length > 0) {
        const firedAt = new Date()
        const rows = outcome.matches.map((m) => ({
          id: randomUUID(),
          ruleId: m.ruleId,
          workspaceId: session.workspaceId,
          sessionId: body.sessionId,
          agentId: body.agentId,
          connectorId: body.connectorId,
          tool: body.tool,
          path: typeof body.params?.path === 'string' ? body.params.path : null,
          ruleName: m.ruleName,
          verdict: m.verdict,
          matchedOn: m.matchedOn as unknown as Prisma.InputJsonValue,
          message: m.message,
          createdAt: firedAt,
        }))
        await app.prisma.ruleDecision.createMany({ data: rows })
      }

      if (outcome.decision === 'deny' && outcome.winning) {
        return {
          decision: 'deny',
          ruleId: outcome.winning.ruleId,
          ruleName: outcome.winning.ruleName,
          matchedOn: outcome.winning.matchedOn,
          reason: outcome.reason ?? null,
        }
      }
      if (outcome.matches.length > 0) {
        const first = outcome.matches[0]
        return {
          decision: 'allow',
          ruleId: first.ruleId,
          ruleName: first.ruleName,
          matchedOn: first.matchedOn,
          reason: first.message ?? null,
        }
      }
      return { decision: 'allow' }
    } catch (err) {
      // Fail-open: catchable decision-path failures return 200 allow.
      // The residual 500 boundary is ONLY for genuinely unhandled/catastrophic
      // failures outside this try/catch (Fastify's default error handler).
      app.log.error({ err, workspaceId: session.workspaceId, sessionId: body.sessionId, tool: body.tool }, 'decision evaluation failed; fail-open allow')
      return { decision: 'allow' }
    }
  })

  app.post('/decisions/:pendingId/approve', {
    schema: {
      params: resolveParamsSchema,
      body: resolutionBodySchema,
      response: { 200: resolutionResponseSchema, 404: errorResponseSchema },
    },
  }, async (req, reply) => {
    const { pendingId } = req.params as { pendingId: string }
    await expireIfNeeded(app.prisma, pendingId)
    const result = await resolvePending(app.prisma, pendingId, 'APPROVED', (req.user?.userId ?? 'dev-user') as string, 'api')
    if (!result) return reply.code(404).send({ error: 'Pending decision not found' })
    if (result.changed) {
      const row = await app.prisma.ruleDecision.findUnique({ where: { id: pendingId } })
      if (row) app.wsManager.broadcastDecisionResolved(row.sessionId, { pendingId, sessionId: row.sessionId, status: result.status, resolvedAt: result.resolvedAt?.toISOString() ?? null, resolvedBy: result.resolvedBy })
    }
    return {
      pendingId,
      status: result.status,
      resolvedAt: result.resolvedAt?.toISOString() ?? null,
      resolvedBy: result.resolvedBy,
    }
  })

  app.post('/decisions/:pendingId/deny', {
    schema: {
      params: resolveParamsSchema,
      body: resolutionBodySchema,
      response: { 200: resolutionResponseSchema, 404: errorResponseSchema },
    },
  }, async (req, reply) => {
    const { pendingId } = req.params as { pendingId: string }
    await expireIfNeeded(app.prisma, pendingId)
    const result = await resolvePending(app.prisma, pendingId, 'DENIED', (req.user?.userId ?? 'dev-user') as string, 'api')
    if (!result) return reply.code(404).send({ error: 'Pending decision not found' })
    if (result.changed) {
      const row = await app.prisma.ruleDecision.findUnique({ where: { id: pendingId } })
      if (row) app.wsManager.broadcastDecisionResolved(row.sessionId, { pendingId, sessionId: row.sessionId, status: result.status, resolvedAt: result.resolvedAt?.toISOString() ?? null, resolvedBy: result.resolvedBy })
    }
    return {
      pendingId,
      status: result.status,
      resolvedAt: result.resolvedAt?.toISOString() ?? null,
      resolvedBy: result.resolvedBy,
    }
  })

  app.get('/sessions/:sessionId/rule-decisions', {
    schema: {
      params: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
      response: { 200: { type: 'array', items: ruleDecisionResponseSchema } },
    },
  }, async (req) => {
    const { sessionId } = req.params as { sessionId: string }

    // Lazy expiry: sweep overdue PENDING rows to EXPIRED (never DENY), broadcast decision_resolved.
    const now = new Date()
    const pending = await app.prisma.ruleDecision.findMany({
      where: { sessionId, status: 'PENDING' },
    })
    for (const row of pending) {
      if (row.expiresAt !== null && row.expiresAt <= now) {
        const updated = await expireIfNeeded(app.prisma, row.id)
        if (updated && updated.status === 'EXPIRED') {
          app.wsManager.broadcastDecisionResolved(sessionId, {
            pendingId: updated.id,
            sessionId,
            status: 'EXPIRED',
            resolvedAt: updated.resolvedAt?.toISOString() ?? null,
            resolvedBy: null,
          })
        }
      }
    }

    const rows = await listSessionDecisions(app.prisma, sessionId)
    return rows.map((d) => ({
      id: d.id,
      sessionId: d.sessionId,
      workspaceId: d.workspaceId,
      agentId: d.agentId,
      connectorId: d.connectorId,
      tool: d.tool,
      path: d.path,
      ruleId: d.ruleId,
      ruleName: d.ruleName,
      verdict: d.verdict,
      matchedOn: d.matchedOn,
      message: d.message ?? null,
      status: d.status ?? null,
      pendingKey: d.pendingKey ?? null,
      expiresAt: d.expiresAt?.toISOString() ?? null,
      resolvedAt: d.resolvedAt?.toISOString() ?? null,
      resolvedBy: d.resolvedBy ?? null,
      resolutionMethod: d.resolutionMethod ?? null,
      createdAt: d.createdAt.toISOString(),
    }))
  })
}
