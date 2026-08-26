import { FastifyPluginAsync } from 'fastify'
import type { Prisma } from '@prisma/client'

interface ResolveBody {
  resolution: 'accept_agent' | 'merge_manual' | 'reject_changes'
  resolvedBy: string
  mergedContent?: string
}

export const conflictRoutes: FastifyPluginAsync = async (app) => {
  app.post('/conflicts/:conflictId/resolve', {
    schema: {
      params: {
        type: 'object',
        required: ['conflictId'],
        properties: { conflictId: { type: 'string' } }
      },
      body: {
        type: 'object',
        required: ['resolution', 'resolvedBy'],
        properties: {
          resolution: { type: 'string', enum: ['accept_agent', 'merge_manual', 'reject_changes'] },
          resolvedBy: { type: 'string' },
          mergedContent: { type: 'string' }
        }
      },
      response: {
        200: {
          type: 'object',
          required: ['id', 'status', 'resolution'],
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            resolution: { type: 'string' }
          }
        },
        404: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } }
        }
      }
    }
  }, async (req, reply) => {
    const { conflictId } = req.params as { conflictId: string }
    const body = req.body as ResolveBody

    const conflict = await app.prisma.conflict.findUnique({ where: { id: conflictId } })
    if (!conflict) return reply.code(404).send({ error: 'Conflict not found' })

    const existingChanges = (conflict.changes as Record<string, unknown>) || {}
    const updatedChanges: Record<string, unknown> = {
      ...existingChanges,
      resolution: body.resolution,
      resolvedBy: body.resolvedBy
    }
    if (body.mergedContent !== undefined) {
      updatedChanges.mergedContent = body.mergedContent
    }

    const updated = await app.prisma.conflict.update({
      where: { id: conflictId },
      data: {
        status: 'RESOLVED',
        changes: updatedChanges as Prisma.InputJsonValue
      }
    })

    app.wsManager.broadcastConflictResolved(conflict.sessionId, conflictId, body.resolution)

    return { id: updated.id, status: updated.status, resolution: body.resolution }
  })
}
