import { describe, it, expect, vi, afterEach } from 'vitest'
import { requestDecision, normalizePendingToolCall, DECISION_TIMEOUT_MS } from '../decision.js'

afterEach(() => { vi.restoreAllMocks() })

describe('normalizePendingToolCall', () => {
  it('maps edit/write/patch to edit_file with params.path', () => {
    const p = normalizePendingToolCall({ tool: 'write', sessionID: 's1', callID: 'c' }, { filePath: 'src/a.ts', content: 'x' }, { connectorId: 'opencode', connectorVersion: '0.0.0', agentId: 'oc-1' })
    expect(p).toEqual({ sessionId: 's1', agentId: 'oc-1', connectorId: 'opencode', tool: 'edit_file', params: { path: 'src/a.ts' } })
  })
  it('preserves non-edit tools by name with no path', () => {
    const p = normalizePendingToolCall({ tool: 'bash', sessionID: 's1' }, { command: 'ls' }, { connectorId: 'opencode', connectorVersion: '0.0.0', agentId: 'oc-1' })
    expect(p?.tool).toBe('bash')
    expect(p?.params).toEqual({})
  })
  it('returns null when tool is missing', () => {
    expect(normalizePendingToolCall({ sessionID: 's1' }, undefined, { connectorId: 'opencode', connectorVersion: '0.0.0', agentId: 'oc-1' })).toBeNull()
  })
})

describe('requestDecision', () => {
  it('returns allow on non-200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const r = await requestDecision({ apiBaseUrl: 'http://x' }, { sessionId: 's1', agentId: 'a', connectorId: 'c', tool: 'edit_file', params: {} })
    expect(r).toEqual({ decision: 'allow' })
  })
  it('returns deny with reason when the server denies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ decision: 'deny', reason: 'no' }) }))
    const r = await requestDecision({ apiBaseUrl: 'http://x' }, { sessionId: 's1', agentId: 'a', connectorId: 'c', tool: 'edit_file', params: {} })
    expect(r).toEqual({ decision: 'deny', reason: 'no' })
  })
  it('fails open on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const r = await requestDecision({ apiBaseUrl: 'http://x' }, { sessionId: 's1', agentId: 'a', connectorId: 'c', tool: 'edit_file', params: {} })
    expect(r).toEqual({ decision: 'allow' })
  })
  it('aborts after the adapter timeout and fails open', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_u: string, opts: RequestInit) => new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })))
    const p = requestDecision({ apiBaseUrl: 'http://x' }, { sessionId: 's1', agentId: 'a', connectorId: 'c', tool: 'edit_file', params: {} })
    vi.advanceTimersByTime(DECISION_TIMEOUT_MS + 10)
    const r = await p
    expect(r).toEqual({ decision: 'allow' })
    vi.useRealTimers()
  })
})