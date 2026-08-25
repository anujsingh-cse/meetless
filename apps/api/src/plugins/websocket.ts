import { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { WebSocketServer, WebSocket } from 'ws'
import { v4 as uuidv4 } from 'uuid'
import { wsManager, WSClient, WSManager } from '../services/ws-manager.js'

declare module 'fastify' {
  interface FastifyInstance {
    wsManager: WSManager
  }
}

export const wsPlugin: FastifyPluginAsync = fp(async (app) => {
  const wss = new WebSocketServer({ noServer: true })

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    if (url.pathname === '/api/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    } else {
      socket.destroy()
    }
  })

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const sessionId = url.searchParams.get('sessionId')
    const agentId = url.searchParams.get('agentId') || uuidv4()

    if (!sessionId) { ws.close(4000, 'sessionId required'); return }

    const client: WSClient = { id: uuidv4(), sessionId, agentId, ws, connectedAt: new Date() }
    wsManager.add(client)

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'agent_action') wsManager.broadcastAction(msg.payload)
      } catch { /* ignore invalid JSON */ }
    })

    ws.on('close', () => wsManager.remove(client.id))
    ws.on('error', () => wsManager.remove(client.id))

    ws.send(JSON.stringify({ type: 'connected', clientId: client.id }))
  })

  app.decorate('wsManager', wsManager)
  app.addHook('onClose', async () => {
    for (const client of wss.clients) client.terminate()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })
}, { name: 'websocket', dependencies: ['redis'] })
