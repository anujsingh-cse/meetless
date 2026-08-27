import { describe, it, expect, vi } from 'vitest'
import http from 'http'
import { AddressInfo } from 'net'
import { emitToMeetless } from '../emitter.js'
import type { NormalizedAgentEvent } from '../types.js'

function startServer(handler: (req: http.IncomingMessage, body: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => { handler(req, raw); res.statusCode = 201; res.end('{}') })
    })
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

const event: NormalizedAgentEvent = {
  sessionId: 'sess-1',
  agentId: 'opencode-sess-1',
  tool: 'edit_file',
  params: { path: 'src/a.ts', content: 'x' },
  timestamp: Date.now(),
  connectorId: 'opencode',
  connectorVersion: '1.0.0',
  mcpEventId: 'call-1',
}

describe('emitToMeetless', () => {
  it('posts the event to /api/events with Bearer token', async () => {
    const port = await startServer((req, body) => {
      expect(req.url).toBe('/api/events')
      expect(req.method).toBe('POST')
      expect(req.headers.authorization).toBe('Bearer abc123')
      const payload = JSON.parse(body)
      expect(payload.sessionId).toBe('sess-1')
      expect(payload.mcpEventId).toBe('call-1')
      expect(payload.params).toEqual({ path: 'src/a.ts', content: 'x' })
      expect('result' in payload).toBe(false)
    })
    await emitToMeetless({ apiBaseUrl: `http://127.0.0.1:${port}`, apiToken: 'abc123' }, event)
  })

  it('omits Authorization header when no token is configured', async () => {
    const port = await startServer((req) => {
      expect(req.headers.authorization).toBeUndefined()
    })
    await emitToMeetless({ apiBaseUrl: `http://127.0.0.1:${port}` }, event)
  })

  it('does not throw on non-2xx response (logs only)', async () => {
    const server = http.createServer((_req, res) => { res.statusCode = 400; res.end('{"error":"Invalid sessionId"}') })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    await expect(emitToMeetless({ apiBaseUrl: `http://127.0.0.1:${port}`, apiToken: 't' }, event)).resolves.toBeUndefined()
    server.close()
  })

  it('does not throw on network error (logs only)', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(emitToMeetless({ apiBaseUrl: 'http://127.0.0.1:1', apiToken: 't' }, event)).resolves.toBeUndefined()
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})
