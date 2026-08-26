import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { Prisma } from '@prisma/client'
import { ReconciliationEngine } from '../services/reconciliation.js'

interface PostEventBody {
  sessionId: string
  agentId: string
  tool: string
  params: Record<string, unknown>
  result?: Record<string, unknown>
  connectorId: string
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

    return reply.code(201).send({ id: event.id, sessionId: event.sessionId, tool: event.tool })
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
