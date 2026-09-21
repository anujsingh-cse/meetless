import type { EmitterConfig } from './emitter.js'

export const ASK_POLL_INTERVAL_MS = 2000

export interface PendingToolCall {
  sessionId: string
  agentId: string
  connectorId: string
  tool: string
  params: Record<string, unknown>
}

export interface CreateAskResult {
  pendingId: string
  created: boolean
  expiresAt: string
}

export interface DecisionStatus {
  status: string
}

// POST a normalized pending (tool + params + pendingKey) to /api/decisions.
// Expects the ASK response and returns its pendingId. Idempotent server-side:
// the same (connectorId, sessionId, pendingKey) returns the existing pendingId.
export async function createAsk(
  config: EmitterConfig,
  pending: PendingToolCall & { pendingKey: string }
): Promise<CreateAskResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.apiToken) headers.Authorization = `Bearer ${config.apiToken}`
    const res = await fetch(`${config.apiBaseUrl}/api/decisions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: pending.sessionId,
        agentId: pending.agentId,
        connectorId: pending.connectorId,
        tool: pending.tool,
        params: pending.params,
        pendingKey: pending.pendingKey,
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`decision request failed: ${res.status}`)
    const body = (await res.json()) as { decision?: string; pendingId?: string; expiresAt?: string }
    if (body.decision !== 'ask' || !body.pendingId) {
      throw new Error(`unexpected decision response: ${body.decision ?? 'none'}`)
    }
    return { pendingId: body.pendingId, created: true, expiresAt: body.expiresAt ?? '' }
  } finally {
    clearTimeout(timer)
  }
}

// Poll the existing decision read surface and return the row's TERMINAL lifecycle
// status (APPROVED | DENIED | EXPIRED), or null while the decision is still
// PENDING, not found, or on a transient error (fail-open).
export async function pollDecision(
  config: EmitterConfig,
  sessionId: string,
  pendingId: string
): Promise<DecisionStatus | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const headers: Record<string, string> = {}
    if (config.apiToken) headers.Authorization = `Bearer ${config.apiToken}`
    const res = await fetch(`${config.apiBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/rule-decisions`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
    if (!res.ok) return null
    const rows = (await res.json()) as Array<{ id: string; status: string | null }>
    const row = rows.find((r) => r.id === pendingId)
    if (!row || !row.status) return null
    if (row.status === 'PENDING') return null
    return { status: row.status }
  } catch {
    return null // transient — fail-open, retry
  } finally {
    clearTimeout(timer)
  }
}

// Poll until terminal (APPROVED | DENIED | EXPIRED), bounded by the server-side
// 60s expiry via attempt cap. Transient errors are retried; never converted to DENY.
export async function waitForResolution(
  config: EmitterConfig,
  sessionId: string,
  pendingId: string,
  signal?: { aborted: boolean },
  maxAttempts = 30
): Promise<'APPROVED' | 'DENIED' | 'EXPIRED' | 'TIMEOUT'> {
  let attempts = 0
  for (;;) {
    if (signal?.aborted) return 'TIMEOUT'
    const status = await pollDecision(config, sessionId, pendingId)
    if (status) {
      if (status.status === 'APPROVED' || status.status === 'DENIED' || status.status === 'EXPIRED') {
        return status.status
      }
    }
    attempts++
    if (attempts >= maxAttempts) return 'TIMEOUT'
    await new Promise((resolve) => setTimeout(resolve, ASK_POLL_INTERVAL_MS))
  }
}