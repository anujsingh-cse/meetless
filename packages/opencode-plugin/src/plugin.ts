import type { Plugin } from '@opencode-ai/plugin'
import { normalizeOpenCodeEvent } from './normalizer.js'
import { emitToMeetless } from './emitter.js'
import { loadConfig } from './config.js'
import type { OpenCodeEventInput } from './types.js'

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

export const MeetlessPlugin: Plugin = async () => {
  const config = loadConfig(process.env as Record<string, string | undefined>)
  const deduper = new PathDeduper(1000)
  let currentSession = ''

  async function forward(existing: OpenCodeEventInput): Promise<void> {
    if (!existing.sessionId) existing = { ...existing, sessionId: currentSession }
    if (!existing.sessionId) return
    const normalized = normalizeOpenCodeEvent(existing, {
      connectorId: 'opencode',
      connectorVersion: '0.0.0',
      agentId: config.agentId,
    })
    if (!normalized) return
    const key = `${normalized.sessionId}|${String(normalized.params.path)}`
    if (!deduper.shouldEmit(key)) return
    await emitToMeetless(config, normalized)
  }

  return {
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
    },
  }
}