import {
  OPENCODE_EDIT_TOOLS,
  OPENCODE_CONNECTOR_ID,
  OPENCODE_CONNECTOR_VERSION,
  type OpenCodeEventInput,
  type NormalizedAgentEvent,
} from './types.js'

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

let sequence = 0

function resolvePath(input: OpenCodeEventInput): string | undefined {
  const args = input.args ?? {}
  return str(input.filePath) ?? str(args.filePath) ?? str(args.path)
}

function resolveContentOrPatch(input: OpenCodeEventInput): { content?: string; patch?: string } {
  const args = input.args ?? {}
  const content = str(args.content) ?? str(args.newStr)
  if (content) return { content }
  const patch = str(args.patch)
  if (patch) return { patch }
  // Best-effort: a diff-looking metadata string is treated as a patch.
  const meta = str(input.outputMeta)
  if (meta && meta.includes('@@')) return { patch: meta }
  return {}
}

export function normalizeOpenCodeEvent(
  input: OpenCodeEventInput,
  opts: {
    connectorId?: string
    connectorVersion?: string
    agentId?: string
  } = {}
): NormalizedAgentEvent | null {
  const path = resolvePath(input)
  if (!path) return null

  const params: Record<string, unknown> = { path }

  if (input.eventType === 'file' || (input.tool && OPENCODE_EDIT_TOOLS.has(input.tool))) {
    Object.assign(params, resolveContentOrPatch(input))
  } else {
    // Observed but not an edit path — ignore for reconciliation.
    return null
  }

  const mcpEventId =
    str(input.callId) ?? `opencode-${Date.now()}-${++sequence}`
  const sessionTag = input.sessionId.slice(0, 8)
  const agentId = opts.agentId ?? `opencode-${sessionTag}`

  return {
    sessionId: input.sessionId,
    agentId,
    tool: 'edit_file',
    params,
    timestamp: input.timestamp ?? Date.now(),
    connectorId: opts.connectorId ?? OPENCODE_CONNECTOR_ID,
    connectorVersion: opts.connectorVersion ?? OPENCODE_CONNECTOR_VERSION,
    mcpEventId,
    rawMCPEvent: input,
    // result intentionally omitted — reconciliation needs only content/patch
  }
}
