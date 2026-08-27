import { describe, it, expect } from 'vitest'
import { normalizeOpenCodeEvent } from '../normalizer.js'

const OPTS = { connectorId: 'opencode', connectorVersion: '1.0.0' }

describe('normalizeOpenCodeEvent', () => {
  it('maps edit tool.execute.after to edit_file with content', () => {
    const out = normalizeOpenCodeEvent({
      sessionId: 'sess-1',
      callId: 'call-1',
      tool: 'edit',
      args: { filePath: 'src/app.ts', content: 'function main() {}' },
      eventType: 'tool',
    }, OPTS)
    expect(out).not.toBeNull()
    expect(out!.sessionId).toBe('sess-1')
    expect(out!.agentId).toMatch(/^opencode-sess-1$/)
    expect(out!.tool).toBe('edit_file')
    expect(out!.params).toEqual({ path: 'src/app.ts', content: 'function main() {}' })
    expect(out!.connectorId).toBe('opencode')
    expect(out!.mcpEventId).toBe('call-1')
  })

  it('maps write tool to edit_file using args.path', () => {
    const out = normalizeOpenCodeEvent({
      sessionId: 'sess-1',
      callId: 'call-2',
      tool: 'write',
      args: { path: 'README.md', content: '# hello' },
      eventType: 'tool',
    }, OPTS)
    expect(out).not.toBeNull()
    expect(out!.tool).toBe('edit_file')
    expect(out!.params).toEqual({ path: 'README.md', content: '# hello' })
  })

  it('maps patch tool to edit_file using args.patch', () => {
    const out = normalizeOpenCodeEvent({
      sessionId: 'sess-1',
      callId: 'call-3',
      tool: 'patch',
      args: { filePath: 'src/lib.ts', patch: '@@ -1 +1 @@' },
      eventType: 'tool',
    }, OPTS)
    expect(out).not.toBeNull()
    expect(out!.tool).toBe('edit_file')
    expect(out!.params).toEqual({ path: 'src/lib.ts', patch: '@@ -1 +1 @@' })
  })

  it('maps file.edited (file event) to edit_file using event.path', () => {
    const out = normalizeOpenCodeEvent({
      sessionId: 'sess-1',
      filePath: 'src/other.ts',
      eventType: 'file',
    }, OPTS)
    expect(out).not.toBeNull()
    expect(out!.tool).toBe('edit_file')
    expect(out!.params).toEqual({ path: 'src/other.ts' })
  })

  it('uses MEETLESS agent override when provided', () => {
    const out = normalizeOpenCodeEvent({
      sessionId: 'sess-1',
      callId: 'c',
      tool: 'edit',
      args: { filePath: 'a.ts', content: 'x' },
      eventType: 'tool',
    }, { ...OPTS, agentId: 'my-agent' })
    expect(out!.agentId).toBe('my-agent')
  })

  it('returns null for non-edit tools (bash is not edit_file)', () => {
    const out = normalizeOpenCodeEvent({
      sessionId: 'sess-1',
      callId: 'c',
      tool: 'bash',
      args: { command: 'ls' },
      eventType: 'tool',
    }, OPTS)
    expect(out).toBeNull()
  })

  it('returns null when no path can be resolved', () => {
    const out = normalizeOpenCodeEvent({
      sessionId: 'sess-1',
      callId: 'c',
      tool: 'edit',
      args: { content: 'x' },
      eventType: 'tool',
    }, OPTS)
    expect(out).toBeNull()
  })

  it('omits result field (reconciliation only needs content/patch)', () => {
    const out = normalizeOpenCodeEvent({
      sessionId: 'sess-1',
      callId: 'c',
      tool: 'edit',
      args: { filePath: 'a.ts', content: 'x' },
      eventType: 'tool',
    }, OPTS)
    expect('result' in (out as object)).toBe(false)
  })

  it('generates a mcpEventId when callId is missing', () => {
    const a = normalizeOpenCodeEvent({
      sessionId: 'sess-1', tool: 'edit', args: { filePath: 'a.ts', content: 'x' }, eventType: 'tool',
    }, OPTS)
    const b = normalizeOpenCodeEvent({
      sessionId: 'sess-1', tool: 'edit', args: { filePath: 'a.ts', content: 'x' }, eventType: 'tool',
    }, OPTS)
    expect(a!.mcpEventId).toBeTruthy()
    expect(a!.mcpEventId).not.toBe(b!.mcpEventId)
  })
})
