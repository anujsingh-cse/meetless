import { describe, it, expect, vi } from 'vitest'
import type { PluginInput } from '@opencode-ai/plugin'
import { MeetlessPlugin, buildInputFromToolHook, buildInputFromFileEvent, dedupePath } from '../plugin.js'
import { normalizeOpenCodeEvent } from '../normalizer.js'

vi.mock('../emitter.js', () => ({ emitToMeetless: vi.fn() }))
import { emitToMeetless } from '../emitter.js'

const stubCtx = { client: { app: { log: vi.fn() } } } as unknown as PluginInput

describe('MeetlessPlugin hook adapters', () => {
  it('builds input from tool.execute.after hook args', () => {
    const input = buildInputFromToolHook(
      { tool: 'edit', sessionID: 'sess-1', callID: 'call-1', args: { filePath: 'src/a.ts', content: 'x' } },
      { title: 'Edit src/a.ts', metadata: '' }
    )
    expect(input.tool).toBe('edit')
    expect(input.sessionId).toBe('sess-1')
    expect(input.callId).toBe('call-1')
    expect(input.filePath).toBeUndefined()
    expect(input.args!.filePath).toBe('src/a.ts')
    expect(input.eventType).toBe('tool')
  })

  it('builds input from file.edited event using the real SDK shape (properties.file)', () => {
    const input = buildInputFromFileEvent({ type: 'file.edited', properties: { file: 'src/b.ts' } })
    expect(input.eventType).toBe('file')
    expect(input.filePath).toBe('src/b.ts')
  })

  it('dedupePath returns true on first sight, false on repeat', () => {
    const seen = new Set<string>()
    const key = 'sess-1|src/a.ts'
    expect(dedupePath(seen, key)).toBe(true)   // NEW -> should emit
    expect(dedupePath(seen, key)).toBe(false)  // seen -> dedupe
  })
})

describe('MeetlessPlugin', () => {
  it('exposes the hooks object with tool.execute.after and event', async () => {
    const hooks = await MeetlessPlugin(stubCtx)
    expect(typeof hooks['tool.execute.after']).toBe('function')
    expect(typeof hooks['event']).toBe('function')
  })

  it('non-edit tool.execute.after normalizes to null (no emission)', () => {
    const input = buildInputFromToolHook(
      { tool: 'bash', sessionID: 'sess-1', callID: 'c', args: { command: 'ls' } },
      {}
    )
    expect(normalizeOpenCodeEvent(input, { connectorId: 'opencode' })).toBeNull()
  })

  it('forwards an edit event through the hooks', async () => {
    const hooks = await MeetlessPlugin(stubCtx)
    await hooks['tool.execute.after']!(
      { tool: 'edit', sessionID: 'sess-1', callID: 'call-9', args: { filePath: 'src/a.ts', content: 'x' } },
      { title: '', output: '', metadata: '' }
    )
    expect(emitToMeetless).toHaveBeenCalledTimes(1)
  })
})