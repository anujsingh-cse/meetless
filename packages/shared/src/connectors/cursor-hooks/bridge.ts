import http from 'http'
import type { NormalizedAgentEvent } from '../../types/index.js'
import type { CursorHookPayload } from './types.js'
import { isCursorHookEventName, BRIDGE_SECRET_HEADER } from './types.js'
import { normalizeCursorHookEvent } from './normalizer.js'

export interface BridgeServerOptions {
  secret: string
  connectorVersion: string
}

export class BridgeServer {
  private server: http.Server | null = null
  private _port = 0
  private secret: string
  private connectorVersion: string
  private eventHandlers: ((event: NormalizedAgentEvent) => void)[] = []

  constructor(options: BridgeServerOptions) {
    this.secret = options.secret
    this.connectorVersion = options.connectorVersion
  }

  get port(): number {
    return this._port
  }

  onEvent(handler: (event: NormalizedAgentEvent) => void): void {
    this.eventHandlers.push(handler)
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res))
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        if (addr && typeof addr === 'object') {
          this._port = addr.port
        }
        resolve()
      })
      this.server.on('error', reject)
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => {
        this.server = null
        this._port = 0
        resolve()
      })
    })
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    const providedSecret = req.headers[BRIDGE_SECRET_HEADER]
    if (providedSecret !== this.secret) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      let payload: CursorHookPayload
      try {
        payload = JSON.parse(body) as CursorHookPayload
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
        return
      }

      if (!isCursorHookEventName(payload.hook_event_name)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Unknown hook event: ${payload.hook_event_name}` }))
        return
      }

      const event = normalizeCursorHookEvent(
        {
          hookEventName: payload.hook_event_name,
          timestamp: payload.timestamp ?? new Date().toISOString(),
          cwd: payload.cwd ?? process.cwd(),
          sessionId: payload.session_id ?? '',
          toolName: payload.tool_name,
          toolInput: payload.tool_input,
          toolOutput: payload.tool_output,
          error: payload.error,
          status: payload.status,
          subagentId: payload.subagent_id,
          subagentName: payload.subagent_name,
        },
        'cursor-hooks',
        this.connectorVersion
      )

      if (event) {
        this.eventHandlers.forEach(h => h(event))
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  }
}
