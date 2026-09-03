import { describe, it, expect, beforeEach, vi } from 'vitest'
import { wsManager, WSManager, WSClient } from '../services/ws-manager.js'
import { WebSocket } from 'ws'

class MockWS {
  readyState = WebSocket.OPEN
  sent: string[] = []
  send(data: string) { this.sent.push(data) }
}

describe('WSManager', () => {
  beforeEach(() => {
    // reset singleton state between tests
    (wsManager as unknown as { clients: Map<string, WSClient> }).clients.clear();
    (wsManager as unknown as { sessionClients: Map<string, Set<string>> }).sessionClients.clear()
  })

  function makeClient(id: string, sessionId: string, agentId: string, ws: MockWS): WSClient {
    return { id, sessionId, agentId, ws: ws as unknown as WebSocket, connectedAt: new Date() }
  }

  it('adds and removes clients', () => {
    const ws = new MockWS()
    wsManager.add(makeClient('1', 's1', 'a1', ws))
    expect(wsManager.getSessionClients('s1')).toHaveLength(1)
    wsManager.remove('1')
    expect(wsManager.getSessionClients('s1')).toHaveLength(0)
  })

  it('broadcasts action to session excluding sender', () => {
    const ws1 = new MockWS(), ws2 = new MockWS()
    wsManager.add(makeClient('1', 's1', 'a1', ws1))
    wsManager.add(makeClient('2', 's1', 'a2', ws2))
    wsManager.broadcastAction({ sessionId: 's1', agentId: 'a1', tool: 'test', params: {}, result: null, timestamp: Date.now() })
    expect(ws1.sent).toHaveLength(0)
    expect(ws2.sent).toHaveLength(1)
  })

  it('does not cross broadcast between sessions', () => {
    const ws1 = new MockWS(), ws2 = new MockWS()
    wsManager.add(makeClient('1', 's1', 'a1', ws1))
    wsManager.add(makeClient('2', 's2', 'a2', ws2))
    wsManager.broadcastAction({ sessionId: 's1', agentId: 'a1', tool: 'test', params: {}, result: null, timestamp: Date.now() })
    expect(ws2.sent).toHaveLength(0)
  })
})

describe('broadcastRuleHit', () => {
  it('broadcasts a single-nested rule_triggered message to the session', () => {
    const send = vi.fn()
    const fakeWs = { readyState: WebSocket.OPEN, send } as unknown as import('ws').WebSocket
    const m = new WSManager()
    m.add({ id: 'c1', sessionId: 's1', agentId: 'a1', ws: fakeWs, connectedAt: new Date() })

    m.broadcastRuleHit('s1', { id: 'hit-1', ruleId: 'r1', ruleName: 'rule', sessionId: 's1', agentId: 'a1' })

    const sent = JSON.parse(send.mock.calls[0][0] as string)
    expect(sent.type).toBe('rule_triggered')
    expect(sent.payload).toEqual({ id: 'hit-1', ruleId: 'r1', ruleName: 'rule', sessionId: 's1', agentId: 'a1' })
  })

  it('does not broadcast when there are no clients in the session', () => {
    const m = new WSManager()
    expect(() => m.broadcastRuleHit('s-absent', { id: 'x' })).not.toThrow()
  })
})
