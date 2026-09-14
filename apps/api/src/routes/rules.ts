import { FastifyPluginAsync } from 'fastify'
import { isValidGlob } from '../services/rule-engine.js'
import type { RuleAction } from '../services/rule-engine.js'

interface RuleBody {
  workspaceId?: string
  name?: string
  description?: string
  enabled?: boolean
  priority?: number
  tool?: string
  pathPattern?: string
  connectorId?: string
  agentPattern?: string
  action?: RuleAction
  message?: string
  createdBy?: string
}

const ruleResponseSchema = {
  type: 'object',
  required: ['id', 'workspaceId', 'name', 'enabled', 'priority', 'action', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    workspaceId: { type: 'string' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    enabled: { type: 'boolean' },
    priority: { type: 'integer' },
    tool: { type: ['string', 'null'] },
    pathPattern: { type: ['string', 'null'] },
    connectorId: { type: ['string', 'null'] },
    agentPattern: { type: ['string', 'null'] },
    action: { type: 'string', enum: ['LOG', 'NOTIFY'] },
    message: { type: ['string', 'null'] },
    createdBy: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const

const hitResponseSchema = {
  type: 'object',
  required: ['id', 'ruleId', 'workspaceId', 'sessionId', 'agentId', 'connectorId', 'tool', 'ruleName', 'action', 'matchedOn', 'createdAt'],
  properties: {
    id: { type: 'string' },
    ruleId: { type: 'string' },
    workspaceId: { type: 'string' },
    sessionId: { type: 'string' },
    agentId: { type: 'string' },
    connectorId: { type: 'string' },
    tool: { type: 'string' },
    path: { type: ['string', 'null'] },
    ruleName: { type: 'string' },
    action: { type: 'string', enum: ['LOG', 'NOTIFY'] },
    matchedOn: { type: 'object', additionalProperties: true },
    message: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const

function toPublicRule(r: {
  id: string; workspaceId: string; name: string; description: string | null; enabled: boolean; priority: number;
  tool: string | null; pathPattern: string | null; connectorId: string | null; agentPattern: string | null;
  action: RuleAction; message: string | null; createdBy: string | null; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: r.id, workspaceId: r.workspaceId, name: r.name, description: r.description, enabled: r.enabled,
    priority: r.priority, tool: r.tool, pathPattern: r.pathPattern, connectorId: r.connectorId,
    agentPattern: r.agentPattern, action: r.action, message: r.message, createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  }
}

const toStringOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null

function validateConstraints(fields: {
  tool?: unknown; pathPattern?: unknown; connectorId?: unknown; agentPattern?: unknown;
}, globCtx: { pathPattern?: unknown; agentPattern?: unknown } = {}): string | null {
  const tool = toStringOrNull(fields.tool)
  const pathPattern = toStringOrNull(fields.pathPattern)
  const connectorId = toStringOrNull(fields.connectorId)
  const agentPattern = toStringOrNull(fields.agentPattern)
  if (tool === null && pathPattern === null && connectorId === null && agentPattern === null) {
    return 'Rule requires at least one constraint (tool, pathPattern, connectorId, agentPattern)'
  }
  const pp = toStringOrNull(globCtx.pathPattern ?? fields.pathPattern)
  if (pp !== null && !isValidGlob(pp)) return 'Invalid glob pattern: pathPattern'
  const ap = toStringOrNull(globCtx.agentPattern ?? fields.agentPattern)
  if (ap !== null && !isValidGlob(ap)) return 'Invalid glob pattern: agentPattern'
  return null
}

export const ruleRoutes: FastifyPluginAsync = async (app) => {
  app.post('/rules', {
    schema: {
      body: {
        type: 'object',
        required: ['workspaceId', 'name', 'action'],
        properties: {
          workspaceId: { type: 'string' },
          name: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          enabled: { type: 'boolean' },
          priority: { type: 'integer' },
          tool: { type: 'string' },
          pathPattern: { type: 'string' },
          connectorId: { type: 'string' },
          agentPattern: { type: 'string' },
          action: { type: 'string', enum: ['LOG', 'NOTIFY'] },
          message: { type: 'string' },
          createdBy: { type: 'string' },
        },
      },
      response: { 201: ruleResponseSchema, 400: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } } },
    },
  }, async (req, reply) => {
    const body = req.body as RuleBody
    const workspace = await app.prisma.workspace.findUnique({ where: { id: body.workspaceId! } })
    if (!workspace) return reply.code(400).send({ error: 'Invalid workspaceId' })

    const err = validateConstraints(body)
    if (err) return reply.code(400).send({ error: err })

    const rule = await app.prisma.rule.create({
      data: {
        workspaceId: body.workspaceId!,
        name: body.name!,
        description: body.description,
        enabled: body.enabled ?? true,
        priority: body.priority ?? 100,
        tool: toStringOrNull(body.tool),
        pathPattern: toStringOrNull(body.pathPattern),
        connectorId: toStringOrNull(body.connectorId),
        agentPattern: toStringOrNull(body.agentPattern),
        action: body.action!,
        message: body.message,
        createdBy: body.createdBy,
      },
    })
    return reply.code(201).send(toPublicRule(rule))
  })

  app.get('/rules', {
    schema: {
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
      response: { 200: { type: 'array', items: ruleResponseSchema } },
    },
  }, async (req) => {
    const { workspaceId } = req.query as { workspaceId: string }
    const rules = await app.prisma.rule.findMany({
      where: { workspaceId },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    })
    return rules.map(toPublicRule)
  })

  app.patch('/rules/:id', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: ['string', 'null'] },
          enabled: { type: 'boolean' },
          priority: { type: 'integer' },
          tool: { type: ['string', 'null'] },
          pathPattern: { type: ['string', 'null'] },
          connectorId: { type: ['string', 'null'] },
          agentPattern: { type: ['string', 'null'] },
          action: { type: 'string', enum: ['LOG', 'NOTIFY'] },
          message: { type: ['string', 'null'] },
          createdBy: { type: ['string', 'null'] },
        },
      },
      response: { 200: ruleResponseSchema, 400: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } }, 404: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } } },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as RuleBody
    const existing = await app.prisma.rule.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: 'Rule not found' })

    const merged = {
      tool: body.tool !== undefined ? toStringOrNull(body.tool) : existing.tool,
      pathPattern: body.pathPattern !== undefined ? toStringOrNull(body.pathPattern) : existing.pathPattern,
      connectorId: body.connectorId !== undefined ? toStringOrNull(body.connectorId) : existing.connectorId,
      agentPattern: body.agentPattern !== undefined ? toStringOrNull(body.agentPattern) : existing.agentPattern,
    }
    const err = validateConstraints(merged)
    if (err) return reply.code(400).send({ error: err })

    const updated = await app.prisma.rule.update({
      where: { id },
      data: {
        name: body.name ?? existing.name,
        description: body.description !== undefined ? body.description : existing.description,
        enabled: body.enabled ?? existing.enabled,
        priority: body.priority ?? existing.priority,
        tool: merged.tool,
        pathPattern: merged.pathPattern,
        connectorId: merged.connectorId,
        agentPattern: merged.agentPattern,
        action: body.action ?? (existing.action as RuleAction),
        message: body.message !== undefined ? body.message : existing.message,
        createdBy: body.createdBy !== undefined ? body.createdBy : existing.createdBy,
      },
    })
    return updated
  })

  app.delete('/rules/:id', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      response: { 200: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, 404: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } } },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await app.prisma.rule.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: 'Rule not found' })
    await app.prisma.rule.delete({ where: { id } })
    return { id }
  })

  app.get('/sessions/:sessionId/rule-hits', {
    schema: {
      params: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
      response: { 200: { type: 'array', items: hitResponseSchema } },
    },
  }, async (req) => {
    const { sessionId } = req.params as { sessionId: string }
    const hits = await app.prisma.ruleHit.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    return hits.map((h) => ({
      id: h.id, ruleId: h.ruleId, workspaceId: h.workspaceId, sessionId: h.sessionId,
      agentId: h.agentId, connectorId: h.connectorId, tool: h.tool, path: h.path,
      ruleName: h.ruleName, action: h.action, matchedOn: h.matchedOn, message: h.message,
      createdAt: h.createdAt.toISOString(),
    }))
  })
}
