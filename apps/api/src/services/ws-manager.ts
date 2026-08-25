import { WebSocket } from 'ws'
import type { AgentAction } from '@meetless/shared/types'

export interface WSClient {
  id: string
  sessionId: string
  agentId: string
  ws: WebSocket
  connectedAt: Date
}

export class WSManager {
  private clients = new Map<string, WSClient>()
  private sessionClients = new Map<string, Set<string>>()

  add(client: WSClient) {
    this.clients.set(client.id, client)
    if (!this.sessionClients.has(client.sessionId)) this.sessionClients.set(client.sessionId, new Set())
    this.sessionClients.get(client.sessionId)!.add(client.id)
  }

  remove(clientId: string) {
    const client = this.clients.get(clientId)
    if (client) {
      this.sessionClients.get(client.sessionId)?.delete(clientId)
      if (this.sessionClients.get(client.sessionId)?.size === 0) {
        this.sessionClients.delete(client.sessionId)
      }
      this.clients.delete(clientId)
    }
  }

  broadcastToSession(sessionId: string, message: unknown, excludeId?: string) {
    const ids = this.sessionClients.get(sessionId)
    if (!ids) return
    const data = JSON.stringify(message)
    for (const id of ids) {
      if (id !== excludeId) {
        const client = this.clients.get(id)
        if (client?.ws.readyState === WebSocket.OPEN && client.agentId !== excludeId) client.ws.send(data)
      }
    }
  }

  broadcastAction(action: AgentAction) {
    this.broadcastToSession(action.sessionId, { type: 'agent_action', payload: action }, action.agentId)
  }

  getSessionClients(sessionId: string): WSClient[] {
    const ids = this.sessionClients.get(sessionId)
    if (!ids) return []
    return Array.from(ids).map(id => this.clients.get(id)!).filter(Boolean)
  }
}

export const wsManager = new WSManager()
