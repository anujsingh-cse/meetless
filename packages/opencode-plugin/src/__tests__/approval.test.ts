import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAsk, pollDecision, waitForResolution, ASK_POLL_INTERVAL_MS } from '../approval.js'

afterEach(() => { vi.restoreAllMocks() })

const config = { apiBaseUrl: 'http://meetless.test' }
const pending = {
  sessionId: 'sess-1',
  agentId: 'oc-1',
  connectorId: 'opencode',
  tool: 'edit_file',
  params: { path: 'contracts/api.yaml' },
  pendingKey: 'perm-1',
}

describe('createAsk', () => {
  it('POSTs the normalized pending to /api/decisions and returns pendingId', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ decision: 'ask', pendingId: 'p-1', expiresAt: '2026-01-01T00:01:00Z' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const res = await createAsk(config, pending)
    expect(res.pendingId).toBe('p-1')
    expect(res.created).toBe(true)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('http://meetless.test/api/decisions')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body.sessionId).toBe('sess-1')
    expect(body.agentId).toBe('oc-1')
    expect(body.connectorId).toBe('opencode')
    expect(body.tool).toBe('edit_file')
    expect(body.params.path).toBe('contracts/api.yaml')
    expect(body.pendingKey).toBe('perm-1')
  })

  it('throws when the server does not return an ask verdict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ decision: 'deny', reason: 'nope' }),
    }))
    await expect(createAsk(config, pending)).rejects.toThrow()
  })

  it('throws on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }))
    await expect(createAsk(config, pending)).rejects.toThrow()
  })
})

describe('pollDecision', () => {
  it('finds the pending by id and returns its terminal status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'p-1', status: 'APPROVED' }],
    }))
    const res = await pollDecision(config, 'sess-1', 'p-1')
    expect(res?.status).toBe('APPROVED')
  })

  it('returns null while PENDING', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'p-1', status: 'PENDING' }],
    }))
    expect(await pollDecision(config, 'sess-1', 'p-1')).toBeNull()
  })

  it('returns null on transient fetch error (fail-open, not a deny)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    expect(await pollDecision(config, 'sess-1', 'p-1')).toBeNull()
  })
})

describe('waitForResolution', () => {
  it('stops and returns APPROVED when approved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'p-1', status: 'APPROVED' }],
    }))
    const out = await waitForResolution(config, 'sess-1', 'p-1')
    expect(out).toBe('APPROVED')
  })

  it('stops and returns DENIED when denied', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'p-1', status: 'DENIED' }],
    }))
    const out = await waitForResolution(config, 'sess-1', 'p-1')
    expect(out).toBe('DENIED')
  })

  it('stops and returns EXPIRED when expired (never DENY)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'p-1', status: 'EXPIRED' }],
    }))
    const out = await waitForResolution(config, 'sess-1', 'p-1')
    expect(out).toBe('EXPIRED')
  })

  it('retries transient failures then continues polling (fail-open)', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 'p-1', status: 'PENDING' }] })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 'p-1', status: 'APPROVED' }] })
    vi.stubGlobal('fetch', fetchMock)
    const out = await waitForResolution(config, 'sess-1', 'p-1')
    expect(out).toBe('APPROVED')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('returns TIMEOUT when the attempt cap is reached (respects server expiry)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'p-1', status: 'PENDING' }],
    }))
    const out = await waitForResolution(config, 'sess-1', 'p-1', { aborted: false }, 2)
    expect(out).toBe('TIMEOUT')
  })

  it('aborts early when the signal is aborted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'p-1', status: 'PENDING' }],
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await waitForResolution(config, 'sess-1', 'p-1', { aborted: true })
    expect(out).toBe('TIMEOUT')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses ASK_POLL_INTERVAL_MS as the cadence', () => {
    expect(ASK_POLL_INTERVAL_MS).toBe(2000)
  })
})