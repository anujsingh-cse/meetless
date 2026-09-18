import http from 'http'
import type { NormalizedAgentEvent } from '../../types/index.js'
import type { CursorHookPayload } from './types.js'
import { isCursorHookEventName, isCursorPermissionHook, BRIDGE_SECRET_HEADER, CursorDecisionConfig } from './types.js'
import { normalizeCursorHookEvent } from './normalizer.js'

export interface BridgeServerOptions {
  secret: string
  connectorVersion: string
  decision?: CursorDecisionConfig
}

export class BridgeServer {
  private server: http.Server | null = null
  private _port = 0
  private secret: string
  private connectorVersion: string
  private decision?: CursorDecisionConfig
  private eventHandlers: ((event: NormalizedAgentEvent) => void)[] = []

  constructor(options: BridgeServerOptions) {
    this.secret = options.secret
    this.connectorVersion = options.connectorVersion
    this.decision = options.decision
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

      void this.respond(res, payload.hook_event_name, event)
    })
  }

  // Permission hooks get a synchronous verdict from Meetless (fail-open to allow);
  // all other hooks stay observe-only and just respond { ok: true }.
  private async respond(res: http.ServerResponse, hookEventName: string, event: NormalizedAgentEvent | null): Promise<void> {
    if (!isCursorPermissionHook(hookEventName) || !event || !this.decision?.baseUrl) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.decision?.timeoutMs ?? 3000)
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (this.decision.apiToken) headers.Authorization = `Bearer ${this.decision.apiToken}`
        const decisionRes = await fetch(`${this.decision.baseUrl}/api/decisions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            sessionId: event.sessionId,
            agentId: event.agentId,
            connectorId: event.connectorId,
            tool: event.tool,
            params: event.params,
          }),
          signal: controller.signal,
        })
        if (!decisionRes.ok) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        const verdictBody = (await decisionRes.json()) as { decision?: string; reason?: string }
        if (verdictBody.decision === 'deny') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, verdict: 'deny', reason: verdictBody.reason }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, verdict: 'allow' }))
      } finally {
        clearTimeout(timer)
      }
    } catch {
      // Fail-open: Meetless unreachable/timeout → no verdict; bridge-client allows.
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }
  }
}
