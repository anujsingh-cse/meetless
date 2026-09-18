import { evaluate } from './rule-engine.js'
import type { RuleEvaluableEvent, RuleLike, RuleMatchedOn, RuleVerdict } from './rule-engine.js'

export const DEFAULT_DENY_REASON_PREFIX = 'Blocked by rule'

export interface RuleDecisionMatch {
  ruleId: string
  ruleName: string
  verdict: RuleVerdict
  matchedOn: RuleMatchedOn
  message: string | null
}

export interface DecisionResult {
  decision: 'allow' | 'deny'
  matches: RuleDecisionMatch[] // all matching prevention rules, deterministic order
  winning?: RuleDecisionMatch  // first DENY in deterministic order (highest priority)
  reason?: string | null       // winning deny's message; default when null
}

// Only rules explicitly participating in prevention (decision set) are considered.
// LOG/NOTIFY rules and rules with decision === null/undefined never deny.
export function selectPreventionRules(rules: RuleLike[]): RuleLike[] {
  return rules.filter((r) => r.decision === 'ALLOW' || r.decision === 'DENY')
}

export function decide(event: RuleEvaluableEvent, rules: RuleLike[]): DecisionResult {
  const prevention = selectPreventionRules(rules)
  const results = evaluate(event, prevention) // shared evaluator: deterministic order
  const matches: RuleDecisionMatch[] = results.map((r) => ({
    ruleId: r.ruleId,
    ruleName: r.ruleName,
    verdict: prevention.find((p) => p.id === r.ruleId)?.decision ?? 'ALLOW',
    matchedOn: r.matchedOn,
    message: r.message,
  }))
  const winning = matches.find((m) => m.verdict === 'DENY')
  if (winning) {
    return {
      decision: 'deny',
      matches,
      winning,
      reason: winning.message ?? `${DEFAULT_DENY_REASON_PREFIX} ${winning.ruleName}`,
    }
  }
  return { decision: 'allow', matches }
}