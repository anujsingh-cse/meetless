import picomatch from 'picomatch'

export type RuleAction = 'LOG' | 'NOTIFY'

export type RuleVerdict = 'ALLOW' | 'DENY'

// Narrow shared evaluation contract. A full NormalizedAgentEvent is a valid
// superset: it has agentId, connectorId, tool, and params (params is `unknown`
// there too). Only params.path (a string) is read by the matcher.
export interface RuleEvaluableEvent {
  agentId: string
  connectorId: string
  tool: string
  params: unknown
}

export interface RuleLike {
  id: string
  name: string
  enabled: boolean
  priority: number
  tool: string | null
  pathPattern: string | null
  connectorId: string | null
  agentPattern: string | null
  action: RuleAction
  decision?: RuleVerdict | null
  message: string | null
  createdAt: Date | string
}

export interface RuleMatchedOn {
  tool: string | null
  pathPattern: string | null
  connectorId: string | null
  agentPattern: string | null
}

export interface RuleEvaluationResult {
  ruleId: string
  ruleName: string
  action: RuleAction
  message: string | null
  matchedOn: RuleMatchedOn
  event: { agentId: string; connectorId: string; tool: string; path: string | null }
}

const normalizePath = (p: string): string => p.replaceAll('\\', '/')

export function isValidGlob(pattern: string): boolean {
  if (typeof pattern !== 'string' || pattern.length === 0) return false
  // picomatch is lenient and rarely throws; enforce balanced delimiters so
  // malformed patterns (unbalanced (){}[]) are rejected at write time.
  const open: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  const stack: string[] = []
  let escaped = false
  for (const ch of pattern) {
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (open[ch] !== undefined) { stack.push(open[ch]); continue }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.length === 0 || stack.pop() !== ch) return false
    }
  }
  if (stack.length !== 0) return false
  try {
    picomatch(pattern, { dot: true })
    return true
  } catch {
    return false
  }
}

function eventPath(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null
  const p = (params as Record<string, unknown>).path
  return typeof p === 'string' ? p : null
}

function matchesRule(rule: RuleLike, path: string | null, event: RuleEvaluableEvent): boolean {
  if (rule.tool !== null && rule.tool !== event.tool) return false
  if (rule.connectorId !== null && rule.connectorId !== event.connectorId) return false
  if (rule.agentPattern !== null && !picomatch(rule.agentPattern, { dot: true })(event.agentId)) return false
  if (rule.pathPattern !== null) {
    if (path === null) return false
    if (!picomatch(rule.pathPattern, { dot: true })(normalizePath(path))) return false
  }
  return true
}

function byDeterministicOrder(a: RuleLike, b: RuleLike): number {
  if (a.priority !== b.priority) return a.priority - b.priority
  const at = new Date(a.createdAt).getTime()
  const bt = new Date(b.createdAt).getTime()
  if (at !== bt) return at - bt
  return a.id.localeCompare(b.id)
}

export function evaluate(event: RuleEvaluableEvent, rules: RuleLike[]): RuleEvaluationResult[] {
  const path = eventPath(event.params)
  return [...rules]
    .sort(byDeterministicOrder)
    .filter((r) => r.enabled)
    .filter((r) => matchesRule(r, path, event))
    .map((r) => ({
      ruleId: r.id,
      ruleName: r.name,
      action: r.action,
      message: r.message,
      matchedOn: { tool: r.tool, pathPattern: r.pathPattern, connectorId: r.connectorId, agentPattern: r.agentPattern },
      event: { agentId: event.agentId, connectorId: event.connectorId, tool: event.tool, path },
    }))
}
