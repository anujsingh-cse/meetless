import type { EmitterConfig } from './emitter.js'

export const DECISION_TIMEOUT_MS = 3000 // adapter-enforced, independent of harness timeout

export interface PendingToolCall {
  sessionId: string
  agentId: string
  connectorId: string
  tool: string
  params: Record<string, unknown>
}

export interface DecisionResponse {
  decision: 'allow' | 'deny'
  reason?: string
}

// Fail-open: network error / timeout / non-2xx ⇒ allow.
export async function requestDecision(
  config: EmitterConfig,
  pending: PendingToolCall
): Promise<DecisionResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DECISION_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.apiToken) headers.Authorization = `Bearer ${config.apiToken}`
    const res = await fetch(`${config.apiBaseUrl}/api/decisions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(pending),
      signal: controller.signal,
    })
    if (!res.ok) return { decision: 'allow' }
    const body = (await res.json()) as { decision?: string; reason?: string }
    return { decision: body.decision === 'deny' ? 'deny' : 'allow', reason: body.reason }
  } catch {
    return { decision: 'allow' } // timeout or network failure ⇒ fail-open
  } finally {
    clearTimeout(timer)
  }
}

// Normalize a raw tool.execute.before input into a RuleEvaluableEvent-shaped pending call.
// edit/write/patch → edit_file with params.path (same mapping as the ingestion normalizer).
// NOTE: the installed @opencode-ai/plugin types put tool args on the hook OUTPUT
// (output: { args }) — so args are passed explicitly here, not read from input.
export function normalizePendingToolCall(
  input: { tool?: string; sessionID?: string; callID?: string },
  args: Record<string, unknown> | undefined,
  opts: { connectorId: string; connectorVersion: string; agentId: string }
): PendingToolCall | null {
  const tool = input.tool
  if (!tool) return null
  const isEdit = tool === 'edit' || tool === 'write' || tool === 'patch'
  const normalizedTool = isEdit ? 'edit_file' : tool
  const a = args ?? {}
  const path = typeof a.filePath === 'string' ? a.filePath : typeof a.path === 'string' ? a.path : undefined
  const params: Record<string, unknown> = {}
  if (path !== undefined) params.path = path
  return {
    sessionId: String(input.sessionID ?? ''),
    agentId: opts.agentId,
    connectorId: opts.connectorId,
    tool: normalizedTool,
    params,
  }
}