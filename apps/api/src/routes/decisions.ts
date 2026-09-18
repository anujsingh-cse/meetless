import { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { decide } from '../services/decision-service.js'

interface DecisionBody {
  sessionId: string
  agentId: string
  connectorId: string
  tool: string
  params: Record<string, unknown>
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
  },
} as const

const decisionResponseSchema = {
  type: 'object',
  required: ['decision'],
  properties: {
    decision: { type: 'string', enum: ['allow', 'deny'] },
    ruleId: { type: 'string' },
    ruleName: { type: 'string' },
    matchedOn: { type: 'object', additionalProperties: true },
    reason: { type: ['string', 'null'] },
  },
} as const

export const decisionRoutes: FastifyPluginAsync = async (app) => {
  app.post('/decisions', {
    schema: {
      body: decisionBodySchema,
      response: {
        200: decisionResponseSchema,
        400: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
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
}