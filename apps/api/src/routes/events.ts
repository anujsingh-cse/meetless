import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { ReconciliationEngine } from '../services/reconciliation.js'
import { evaluate } from '../services/rule-engine.js'

interface PostEventBody {
  sessionId: string
  agentId: string
  tool: string
  params: Record<string, unknown>
  result?: Record<string, unknown>
  connectorId: string
  connectorName?: string
  connectorVersion: string
  mcpEventId: string
}

const postEventBodySchema = {
  type: 'object',
  required: [
    'sessionId',
    'agentId',
    'tool',
    'params',
    'connectorId',
    'connectorVersion',
    'mcpEventId',
  ],
  properties: {
    sessionId: { type: 'string' },
    agentId: { type: 'string' },
    tool: { type: 'string' },
    params: { type: 'object', additionalProperties: true },
    result: { type: 'object', additionalProperties: true },
    connectorId: { type: 'string' },
    connectorName: { type: 'string' },
    connectorVersion: { type: 'string' },
    mcpEventId: { type: 'string' },
  },
} as const

const conflictItemSchema = {
  type: 'object',
  required: ['id', 'sessionId', 'file', 'agents', 'status', 'createdAt'],
  properties: {
    id: { type: 'string' },
    sessionId: { type: 'string' },
    file: { type: 'string' },
    agents: { type: 'array', items: { type: 'string' } },
    status: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const

export const eventRoutes: FastifyPluginAsyncZod = async (app) => {
  const reconciliation = new ReconciliationEngine(app.prisma, (msg: unknown) => {
    const payload = msg as { type?: string; sessionId?: string; file?: string; agents?: string[] }
    if (payload.sessionId) {
      app.wsManager.broadcastConflict(payload.sessionId, payload)
    }
  })

  app.post('/events', {
    schema: {
      body: postEventBodySchema,
      response: {
        201: {
          type: 'object',
          required: ['id', 'sessionId', 'tool'],
          properties: {
            id: { type: 'string' },
            sessionId: { type: 'string' },
            tool: { type: 'string' },
            ruleHits: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'ruleId', 'ruleName', 'action', 'matchedOn', 'createdAt'],
                properties: {
                  id: { type: 'string' },
                  ruleId: { type: 'string' },
                  ruleName: { type: 'string' },
                  action: { type: 'string', enum: ['LOG', 'NOTIFY'] },
                  message: { type: ['string', 'null'] },
                  path: { type: ['string', 'null'] },
                  tool: { type: 'string' },
                  agentId: { type: 'string' },
                  connectorId: { type: 'string' },
                  sessionId: { type: 'string' },
                  workspaceId: { type: 'string' },
                  matchedOn: { type: 'object', additionalProperties: true },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        400: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body as PostEventBody

    const session = await app.prisma.session.findUnique({ where: { id: body.sessionId } })
    if (!session) return reply.code(400).send({ error: 'Invalid sessionId' })

    await app.prisma.connector.upsert({
      where: { id: body.connectorId },
      update: { name: body.connectorName ?? body.connectorId, version: body.connectorVersion },
      create: { id: body.connectorId, name: body.connectorName ?? body.connectorId, version: body.connectorVersion, capabilities: {} }
    })

    const event = await app.prisma.normalizedEvent.create({
      data: {
        sessionId: body.sessionId,
        agentId: body.agentId,
        tool: body.tool,
        params: body.params as unknown as Prisma.InputJsonValue,
        result: (body.result ?? {}) as unknown as Prisma.InputJsonValue,
        connectorId: body.connectorId,
        connectorVersion: body.connectorVersion,
        mcpEventId: body.mcpEventId,
        timestamp: new Date()
      }
    })

    // --- Rule engine seam (additive; never blocks ingestion or reconciliation) ---
    let ruleHits: Array<Record<string, unknown>> | undefined
    try {
      const rules = await app.prisma.rule.findMany({
        where: { workspaceId: session.workspaceId, enabled: true },
      })
      if (rules.length > 0) {
        const results = evaluate({
          agentId: event.agentId,
          tool: event.tool,
          params: event.params,
          connectorId: event.connectorId,
        }, rules)
        if (results.length > 0) {
          const firedAt = new Date()
          const hits = results.map((r) => ({
            id: randomUUID(),
            ruleId: r.ruleId,
            workspaceId: session.workspaceId,
            sessionId: event.sessionId,
            agentId: event.agentId,
            connectorId: event.connectorId,
            tool: event.tool,
            path: r.event.path,
            ruleName: r.ruleName,
            action: r.action,
            matchedOn: r.matchedOn as unknown as Prisma.InputJsonValue,
            message: r.message,
            createdAt: firedAt,
          }))
          await app.prisma.ruleHit.createMany({ data: hits })
          for (const hit of hits) {
            if (hit.action === 'NOTIFY') app.wsManager.broadcastRuleHit(hit.sessionId, hit)
          }
          ruleHits = hits.map((h) => ({ ...h, matchedOn: h.matchedOn, createdAt: h.createdAt.toISOString() }))
        }
      }
    } catch (err) {
      app.log.error({ err, workspaceId: session.workspaceId, sessionId: event.sessionId, tool: event.tool }, 'rule evaluation failed; ingestion unaffected')
    }

    await reconciliation.processSessionEvent({
      sessionId: event.sessionId,
      agentId: event.agentId,
      tool: event.tool,
      params: event.params,
      result: event.result ?? undefined,
      timestamp: event.timestamp.getTime(),
      connectorId: event.connectorId,
      connectorVersion: event.connectorVersion,
      mcpEventId: event.mcpEventId
    })

    return reply.code(201).send({ id: event.id, sessionId: event.sessionId, tool: event.tool, ruleHits })
  })

  app.get('/sessions/:sessionId/conflicts', {
    schema: {
      response: {
        200: { type: 'array', items: conflictItemSchema },
      },
    },
  }, async (req) => {
    const { sessionId } = req.params as { sessionId: string }
    const conflicts = await app.prisma.conflict.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' }
    })
    return conflicts.map(c => ({
      id: c.id,
      sessionId: c.sessionId,
      file: c.file,
      agents: c.agents,
      status: c.status,
      createdAt: c.createdAt.toISOString()
    }))
  })
}
