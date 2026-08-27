import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'http'
import { BridgeServer } from '../bridge.js'
import type { NormalizedAgentEvent } from '../../../types/index.js'

describe('BridgeServer', () => {
  let bridge: BridgeServer

  beforeEach(() => {
    bridge = new BridgeServer({ secret: 'test-secret', connectorVersion: '1.0.0' })
  })

  afterEach(async () => {
    await bridge.stop()
  })

  it('starts and binds to a port', async () => {
    await bridge.start()
    expect(bridge.port).toBeGreaterThan(0)
    expect(bridge.port).toBeLessThan(65536)
  })

  it('accepts valid hook events with correct secret', async () => {
    const events: NormalizedAgentEvent[] = []
    bridge.onEvent(e => events.push(e))
    await bridge.start()

    const payload = JSON.stringify({
      hook_event_name: 'preToolUse',
      timestamp: '2026-08-27T10:00:00Z',
      cwd: '/workspace',
      session_id: 'sess-1',
      tool_name: 'Shell',
      tool_input: { command: 'npm test' },
    })

    const res = await makeRequest(bridge.port, payload, 'test-secret')
    expect(res.statusCode).toBe(200)
    expect(events).toHaveLength(1)
    expect(events[0].tool).toBe('bash')
  })

  it('rejects requests with wrong secret', async () => {
    await bridge.start()

    const payload = JSON.stringify({
      hook_event_name: 'preToolUse',
      timestamp: '2026-08-27T10:00:00Z',
      cwd: '/workspace',
      session_id: 'sess-1',
      tool_name: 'Shell',
      tool_input: { command: 'npm test' },
    })

    const res = await makeRequest(bridge.port, payload, 'wrong-secret')
    expect(res.statusCode).toBe(401)
  })

  it('rejects requests with no secret header', async () => {
    await bridge.start()

    const payload = JSON.stringify({
      hook_event_name: 'preToolUse',
      timestamp: '2026-08-27T10:00:00Z',
      cwd: '/workspace',
      session_id: 'sess-1',
    })

    const req = http.request({
      hostname: '127.0.0.1',
      port: bridge.port,
      path: '/hook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on('response', resolve)
      req.on('error', reject)
      req.end(payload)
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects non-JSON payloads', async () => {
    await bridge.start()
    const res = await makeRequest(bridge.port, 'not json', 'test-secret')
    expect(res.statusCode).toBe(400)
  })

  it('rejects invalid hook_event_name', async () => {
    await bridge.start()
    const payload = JSON.stringify({
      hook_event_name: 'nonexistent_event',
      timestamp: '2026-08-27T10:00:00Z',
      cwd: '/workspace',
      session_id: 'sess-1',
    })
    const res = await makeRequest(bridge.port, payload, 'test-secret')
    expect(res.statusCode).toBe(400)
  })

  it('returns 404 for non-/hook paths', async () => {
    await bridge.start()
    const req = http.request({
      hostname: '127.0.0.1',
      port: bridge.port,
      path: '/other',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-meetless-secret': 'test-secret' },
    })
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on('response', resolve)
      req.on('error', reject)
      req.end('{}')
    })
    expect(res.statusCode).toBe(404)
  })

  it('stops cleanly', async () => {
    await bridge.start()
    const port = bridge.port
    await bridge.stop()
    const err = await new Promise<Error | null>((resolve) => {
      const server = http.createServer()
      server.listen(port, '127.0.0.1', () => { server.close(() => resolve(null)) })
      server.on('error', resolve)
    })
    expect(err).toBeNull()
  })
})

function makeRequest(port: number, body: string, secret: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/hook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-meetless-secret': secret,
      },
    })
    req.on('response', resolve)
    req.on('error', reject)
    req.end(body)
  })
}
