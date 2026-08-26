import { PrismaClient } from '@prisma/client'
import type { NormalizedAgentEvent } from '@meetless/shared/types'

interface FileEdit {
  agentId: string
  content: string
}

export class ReconciliationEngine {
  private prisma: PrismaClient
  private broadcaster?: (msg: unknown) => void

  constructor(prisma: PrismaClient, broadcaster?: (msg: unknown) => void) {
    this.prisma = prisma
    this.broadcaster = broadcaster
  }

  async processSessionEvent(event: NormalizedAgentEvent): Promise<void> {
    if (event.tool !== 'edit_file') return

    const params = event.params as { path?: unknown; content?: unknown }
    if (typeof params.path !== 'string') return
    const filePath = params.path

    const rows = await this.prisma.normalizedEvent.findMany({
      where: { sessionId: event.sessionId, tool: 'edit_file' },
      orderBy: { timestamp: 'asc' }
    })

    const editsByAgent = new Map<string, FileEdit>()
    for (const row of rows) {
      const p = row.params as { path?: unknown; content?: unknown }
      if (p.path !== filePath) continue
      editsByAgent.set(row.agentId, {
        agentId: row.agentId,
        content: typeof p.content === 'string' ? p.content : ''
      })
    }

    // Ensure the triggering event is counted even if not yet persisted
    if (!editsByAgent.has(event.agentId)) {
      editsByAgent.set(event.agentId, {
        agentId: event.agentId,
        content: typeof params.content === 'string' ? params.content : ''
      })
    }

    if (editsByAgent.size < 2) return

    const agents = Array.from(editsByAgent.keys())
    const uniqueContents = new Set(Array.from(editsByAgent.values()).map(e => e.content))
    if (uniqueContents.size <= 1) return

    await this.prisma.conflict.upsert({
      where: {
        sessionId_file: { sessionId: event.sessionId, file: filePath }
      },
      update: { agents, status: 'PENDING' },
      create: {
        sessionId: event.sessionId,
        file: filePath,
        agents,
        changes: {
          edits: Array.from(editsByAgent.values()).map(edit => ({
            agent: edit.agentId,
            content: edit.content
          }))
        },
        status: 'PENDING'
      }
    })

    if (this.broadcaster) {
      this.broadcaster({
        type: 'conflict_created',
        sessionId: event.sessionId,
        file: filePath,
        agents
      })
    }
  }

  getSessionConflicts(sessionId: string) {
    return this.prisma.conflict.findMany({ where: { sessionId } })
  }
}
