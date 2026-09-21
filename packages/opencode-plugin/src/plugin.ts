import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import { normalizeOpenCodeEvent } from './normalizer.js'
import { emitToMeetless } from './emitter.js'
import { loadConfig } from './config.js'
import type { PluginConfig } from './config.js'
import { requestDecision, normalizePendingToolCall } from './decision.js'
import { createAsk, waitForResolution } from './approval.js'
import { OPENCODE_CONNECTOR_VERSION, type OpenCodeEventInput } from './types.js'

// Build an OpenCodeEventInput from the documented tool.execute.after hook signature.
export function buildInputFromToolHook(
  input: { tool?: string; sessionID?: string; callID?: string; args?: Record<string, unknown> },
  output: { title?: string; metadata?: string }
): OpenCodeEventInput {
  return {
    sessionId: String(input.sessionID ?? ''),
    callId: input.callID ? String(input.callID) : undefined,
    tool: input.tool,
    args: input.args ?? {},
    outputTitle: output.title,
    outputMeta: output.metadata,
    eventType: 'tool',
  }
}

// Build an OpenCodeEventInput from the universal `event` hook (file.edited, etc.).
// NOTE: the installed @opencode-ai/sdk shapes EventFileEdited as
// { type: 'file.edited', properties: { file: string } } — the file path lives in
// `properties.file` and there is NO sessionID on file.edited. Session context is
// supplied by the plugin's current-session fallback (tracked from hooks that do
// carry it), so forwarding works where session context is available.
export function buildInputFromFileEvent(
  event: { type?: string; sessionID?: string; path?: string; properties?: Record<string, unknown> }
): OpenCodeEventInput {
  const props = event.properties as { file?: string; sessionID?: string } | undefined
  return {
    sessionId: String(event.sessionID ?? props?.sessionID ?? ''),
    filePath: event.path ?? props?.file,
    eventType: event.type === 'file.edited' ? 'file' : 'tool',
  }
}

// Pure helper: returns true if `key` is NEW (caller should emit), false if already present.
export function dedupePath<T>(seen: Set<T>, key: T): boolean {
  if (seen.has(key)) return false
  seen.add(key)
  return true
}

// Tracks (sessionId, path) keys with a time-to-live so the trailing `file.edited`
// event following a `tool.execute.after` for the same path is not double-emitted.
class PathDeduper {
  private seen = new Set<string>()
  private expiresAt = new Map<string, number>()

  constructor(private ttlMs: number) {}

  shouldEmit(key: string): boolean {
    const now = Date.now()
    const at = this.expiresAt.get(key)
    if (at !== undefined && at > now) return false // still within the window -> dupe
    // evict stale keys
    for (const [k, exp] of this.expiresAt) if (exp <= now) { this.seen.delete(k); this.expiresAt.delete(k) }
    dedupePath(this.seen, key)
    this.expiresAt.set(key, now + this.ttlMs)
    return true
  }
}

// Shared agentId derivation for pre-execution (decisions) and post-execution
// (ingestion) paths — identical so agentPattern rules behave the same both ways.
function resolveAgentId(config: PluginConfig, sessionId: string): string {
  return config.agentId ?? `opencode-${sessionId.slice(0, 8)}`
}

export const MeetlessPlugin: Plugin = async ({ client }: PluginInput) => {
  const config = loadConfig(process.env as Record<string, string | undefined>)
  const deduper = new PathDeduper(1000)
  let currentSession = ''
  // permissionID → Meetless pendingId (in-process; rebuilt on restart via server idempotency)
  const pendingByPermission = new Map<string, string>()
  const replied = new Set<string>()

  async function forward(existing: OpenCodeEventInput): Promise<void> {
    if (!existing.sessionId) existing = { ...existing, sessionId: currentSession }
    if (!existing.sessionId) return
    const normalized = normalizeOpenCodeEvent(existing, {
      connectorId: 'opencode',
      connectorVersion: OPENCODE_CONNECTOR_VERSION,
      agentId: resolveAgentId(config, existing.sessionId),
    })
    if (!normalized) return
    const key = `${normalized.sessionId}|${String(normalized.params.path)}`
    if (!deduper.shouldEmit(key)) return
    await emitToMeetless(config, normalized)
  }

  // Asynchronous ASK lifecycle: create/find the pending decision, poll for a
  // resolution, then reply once via the OpenCode permission API. EXPIRED and
  // TIMEOUT produce NO reply (fail-open, no implicit deny).
  async function handlePermissionAsk(permission: {
    id: string
    sessionID: string
    callID?: string
    type?: string
    pattern?: string | Array<string>
  }): Promise<void> {
    const permissionID = permission.id
    const sessionId = String(permission.sessionID)
    if (!permissionID || !sessionId) return
    if (replied.has(permissionID)) return

    let pendingId = pendingByPermission.get(permissionID)
    if (!pendingId) {
      const params: Record<string, unknown> = {}
      const pattern = permission.pattern
      const path = Array.isArray(pattern) ? pattern[0] : pattern
      if (typeof path === 'string' && path.length > 0) params.path = path
      const created = await createAsk(config, {
        sessionId,
        agentId: resolveAgentId(config, sessionId),
        connectorId: 'opencode',
        tool: 'edit_file',
        params,
        pendingKey: permissionID,
      })
      pendingId = created.pendingId
      pendingByPermission.set(permissionID, pendingId)
    }

    const outcome = await waitForResolution(config, sessionId, pendingId)
    if (outcome === 'APPROVED' || outcome === 'DENIED') {
      if (replied.has(permissionID)) return
      await client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID },
        body: { response: outcome === 'APPROVED' ? 'once' : 'reject' },
      })
      replied.add(permissionID)
    }
  }

  return {
    async 'tool.execute.before'(input, output) {
      if (input?.sessionID) currentSession = String(input.sessionID)
      const sessionId = String(input.sessionID ?? currentSession)
      if (!sessionId) return
      const pending = normalizePendingToolCall(input, output?.args, {
        connectorId: 'opencode',
        connectorVersion: OPENCODE_CONNECTOR_VERSION,
        agentId: resolveAgentId(config, sessionId),
      })
      if (!pending) return
      const verdict = await requestDecision(config, pending)
      if (verdict.decision === 'deny') {
        throw new Error(verdict.reason ?? 'Blocked by rule')
      }
    },
    async 'tool.execute.after'(input, output) {
      if (input?.sessionID) currentSession = String(input.sessionID)
      await forward(buildInputFromToolHook(input, output))
    },
    async event({ event }: {
      event?: { type?: string; sessionID?: string; path?: string; properties?: Record<string, unknown> }
    }) {
      if (event?.sessionID) currentSession = String(event.sessionID)
      if (event?.type === 'file.edited') {
        await forward(buildInputFromFileEvent(event))
      }
      if (event?.type === 'permission.updated') {
        const props = event.properties as {
          id?: string
          sessionID?: string
          callID?: string
          type?: string
          pattern?: string | Array<string>
        }
        if (!props?.id || !props?.sessionID) return
        void handlePermissionAsk({
          id: props.id,
          sessionID: props.sessionID,
          callID: props.callID,
          type: props.type,
          pattern: props.pattern,
        })
      }
    },
  }
}