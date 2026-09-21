import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PluginInput } from '@opencode-ai/plugin'
import { MeetlessPlugin, buildInputFromToolHook, buildInputFromFileEvent, dedupePath } from '../plugin.js'
import { normalizeOpenCodeEvent } from '../normalizer.js'

vi.mock('../emitter.js', () => ({ emitToMeetless: vi.fn() }))
import { emitToMeetless } from '../emitter.js'
vi.mock('../decision.js', () => ({
  requestDecision: vi.fn(),
  normalizePendingToolCall: vi.fn(),
}))
import { requestDecision, normalizePendingToolCall } from '../decision.js'
vi.mock('../approval.js', () => ({
  createAsk: vi.fn(),
  waitForResolution: vi.fn(),
}))
import { createAsk, waitForResolution } from '../approval.js'

const stubCtx = { client: { app: { log: vi.fn() } } } as unknown as PluginInput

function makeCtx() {
  const postSessionIdPermissionsPermissionId = vi.fn().mockResolvedValue(true)
  const ctx = {
    client: {
      app: { log: vi.fn() },
      postSessionIdPermissionsPermissionId,
    },
  } as unknown as PluginInput
  return { ctx, postSessionIdPermissionsPermissionId }
}

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

describe('MeetlessPlugin tool.execute.before', () => {
  beforeEach(() => {
    vi.mocked(normalizePendingToolCall).mockImplementation((input, args) => ({
      sessionId: String(input?.sessionID ?? ''),
      agentId: 'oc-1',
      connectorId: 'opencode',
      tool: input?.tool === 'edit' ? 'edit_file' : (input?.tool ?? ''),
      params: (args && typeof args.filePath === 'string') ? { path: args.filePath } : {},
    }))
  })

  it('exposes tool.execute.before', async () => {
    const hooks = await MeetlessPlugin(stubCtx)
    expect(typeof hooks['tool.execute.before']).toBe('function')
  })

  it('throws (blocks execution) when the decision client returns deny', async () => {
    vi.mocked(requestDecision).mockResolvedValue({ decision: 'deny', reason: 'off-limits' })
    const hooks = await MeetlessPlugin(stubCtx)
    await expect(
      hooks['tool.execute.before']!({ tool: 'edit', sessionID: 'sess-1', callID: 'c' }, { args: { filePath: 'src/a.ts' } })
    ).rejects.toThrow('off-limits')
  })

  it('does not throw when the decision client allows', async () => {
    vi.mocked(requestDecision).mockResolvedValue({ decision: 'allow' })
    const hooks = await MeetlessPlugin(stubCtx)
    await expect(
      hooks['tool.execute.before']!({ tool: 'edit', sessionID: 'sess-1', callID: 'c' }, { args: { filePath: 'src/a.ts' } })
    ).resolves.toBeUndefined()
  })
})

describe('MeetlessPlugin permission.updated approval lifecycle', () => {
  beforeEach(() => {
    vi.mocked(createAsk).mockReset()
    vi.mocked(waitForResolution).mockReset()
    vi.mocked(createAsk).mockResolvedValue({ pendingId: 'pending-1', created: true, expiresAt: '2026-01-01T00:01:00Z' })
  })

  const permissionEvent = (id: string, sessionID = 'sess-1') => ({
    type: 'permission.updated',
    properties: { id, sessionID, type: 'edit', pattern: 'contracts/**' },
  })

  it('creates a pending decision and replies "once" on APPROVED', async () => {
    vi.mocked(waitForResolution).mockResolvedValue('APPROVED')
    const { ctx, postSessionIdPermissionsPermissionId } = makeCtx()
    const hooks = await MeetlessPlugin(ctx)

    await hooks['event']!({ event: permissionEvent('perm-1') as never })
    await vi.waitFor(() => expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1))

    expect(createAsk).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sessionId: 'sess-1',
      connectorId: 'opencode',
      tool: 'edit_file',
      pendingKey: 'perm-1',
    }))
    expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
      path: { id: 'sess-1', permissionID: 'perm-1' },
      body: { response: 'once' },
    })
  })

  it('replies "reject" on DENIED', async () => {
    vi.mocked(waitForResolution).mockResolvedValue('DENIED')
    const { ctx, postSessionIdPermissionsPermissionId } = makeCtx()
    const hooks = await MeetlessPlugin(ctx)

    await hooks['event']!({ event: permissionEvent('perm-2') as never })
    await vi.waitFor(() => expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1))

    expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
      path: { id: 'sess-1', permissionID: 'perm-2' },
      body: { response: 'reject' },
    })
  })

  it('makes no permission reply on EXPIRED', async () => {
    vi.mocked(waitForResolution).mockResolvedValue('EXPIRED')
    const { ctx, postSessionIdPermissionsPermissionId } = makeCtx()
    const hooks = await MeetlessPlugin(ctx)

    await hooks['event']!({ event: permissionEvent('perm-3') as never })
    // wait until the fire-and-forget resolves without producing a reply
    await vi.waitFor(() => expect(createAsk).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(postSessionIdPermissionsPermissionId).not.toHaveBeenCalled()
  })

  it('prevents duplicate replies for the same permission id', async () => {
    vi.mocked(waitForResolution).mockResolvedValue('APPROVED')
    const { ctx, postSessionIdPermissionsPermissionId } = makeCtx()
    const hooks = await MeetlessPlugin(ctx)

    await hooks['event']!({ event: permissionEvent('perm-4') as never })
    await vi.waitFor(() => expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1))
    await hooks['event']!({ event: permissionEvent('perm-4') as never })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1)
  })

  it('reuses the existing pendingId for a repeated permission.updated (server idempotency)', async () => {
    vi.mocked(waitForResolution).mockResolvedValue('APPROVED')
    const { ctx, postSessionIdPermissionsPermissionId } = makeCtx()
    const hooks = await MeetlessPlugin(ctx)

    await hooks['event']!({ event: permissionEvent('perm-5') as never })
    await vi.waitFor(() => expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1))
    await hooks['event']!({ event: permissionEvent('perm-5') as never })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(createAsk).toHaveBeenCalledTimes(1)
    expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1)
  })
})