# Phase 2D: OpenCode Native Plugin Connector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenCode a first-class Meetless connector using an **in-process OpenCode plugin** that observes OpenCode events, normalizes them into the existing `NormalizedAgentEvent` contract, and sends them through the existing Meetless ingestion and reconciliation pipeline.

**Architecture:** A native OpenCode plugin module (`@meetless/opencode`) loads inside the OpenCode server process. It subscribes to `tool.execute.after` (hook) and `file.edited` (event hook via the universal `event` subscriber). A pure **normalizer** maps OpenCode event data → `NormalizedAgentEvent` (tool `edit_file`, `params.path`, `params.content`/`params.patch`, session/agent id, `callID` → `mcpEventId`). An **emitter** POSTs non-null events to the existing `POST /api/events` with `Authorization: Bearer <token>`. The existing IngestionPipeline and ReconciliationEngine consume the events **unchanged** — no engine modifications. Phase 2D is **strictly observe-only**: no `tool.execute.before` enforcement, no bidirectional control.

```
OpenCode server (Bun, in-process)
  MeetlessPlugin
    ├─ tool.execute.after (hook)  ─┐
    ├─ file.edited (event)         ─┴→ OpenCodeEventInput → normalizer → NormalizedAgentEvent
    └─ emitter: POST /api/events (Bearer token)
                                                        ↓
                                    existing IngestionPipeline / ReconciliationEngine (unchanged)
```

**Tech Stack:** TypeScript, `@opencode-ai/plugin` (type-only import for the `Plugin` type), Node/Bun global `fetch`, Vitest (tests), `npm workspaces` (+ turbo via the existing monorepo), `tsx` (demo).

**Spec:** Phase 2D approved architecture (prompt) + `docs/project-overview.md` connector contract. This plan implements the approved Phase 2D specification only.

## Global Constraints

- Windows PowerShell environment — never use `mkdir -p`; use `New-Item -ItemType Directory -Force` and never check existence first.
- **Plugin runs in Bun inside the OpenCode server.** The plugin must NOT import `@meetless/shared` at runtime (its `config` module calls `dotenv/config` and `process.exit` and has CJS/mixed output). Type-only imports from `@meetless/shared/types` are allowed (erased at compile). To be safe the plugin declares its own structurally-identical `NormalizedAgentEvent`-compatible local interface and never imports shared at runtime.
- `@opencode-ai/plugin` is used **only** as a type-only import (`import type { Plugin }`) in `devDependencies`. No runtime dependency on it in the built plugin.
- New connector ID: `opencode`. Existing connector IDs: `claude-code`, `codex-cli`, `cursor-hooks`.
- **Observe-only.** Do NOT implement `tool.execute.before` enforcement, tool veto, or any bidirectional control in this phase.
- **Do not modify** `apps/api/src/services/reconciliation.ts`, `apps/api/src/routes/events.ts`, the Prisma schema, or `@meetless/shared` connectors/ingestion. All OpenCode-specific logic stays inside `packages/opencode-plugin/`.
- `POST /api/events` rejects an unknown `sessionId` with 400. The plugin therefore attributes events to a Meetless `Session.id` that must exist (the demo and E2E create the session explicitly). See Task 6 + Task 8 for the identity strategy. **No generic session auto-provisioning is introduced in this phase** (kept narrow; documented as future work).
- `normalizedEvent.params` must be an object; `result` may be omitted (the API omits it when absent) — see the `result: null` fix precedent (`54cdbbd`). The emitter omits `result` unless it is a non-null object.
- Reconciliation compares events per `(sessionId, path)` using `params.content` OR `params.patch` (string). The normalizer emits `content` or `patch` accordingly.
- Agent id follows the existing connector convention (Cursor uses `cursor-<sess8>`): OpenCode uses `opencode-<sessionId.slice(0,8)>`, with optional `MEETLESS_AGENT_ID` override.
- Secrets (API token) are read from env and **never logged**. The emitter logs only status codes / sanitized ids on failure.
- E2E tests use `vitest` with `buildApp()` from `apps/api/src/app.ts` (exactly like `e2e-cursor-hooks.test.ts`). Demo scripts run via `npx tsx scripts/<name>.ts`.
- `docs/superpowers/plans/` is tracked; `.superpowers/` is gitignored.
- `packages/opencode-plugin/` is a new npm workspace under `packages/*`, so it joins `npm workspaces` and turbo automatically (root `package.json` workspaces: `apps/*`, `packages/*`).

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `packages/opencode-plugin/package.json` | `@meetless/opencode` package — `type: module`, `tsc` build, vitest, lint, `@opencode-ai/plugin` devDep |
| `packages/opencode-plugin/tsconfig.json` | Extends `../../tsconfig.base.json`, `rootDir: src`, `outDir: dist` |
| `packages/opencode-plugin/vitest.config.ts` | Vitest config (tests under `src/**/__tests__/**`) |
| `packages/opencode-plugin/.eslintrc.cjs` | ESLint config (matches other packages, `.ts`) |
| `packages/opencode-plugin/src/types.ts` | OpenCode event input types + normalized-event local interface + tool map |
| `packages/opencode-plugin/src/normalizer.ts` | Pure `normalizeOpenCodeEvent(...)` → `NormalizedAgentEvent \| null` |
| `packages/opencode-plugin/src/emitter.ts` | `emitToMeetless(config, event)`: POST `/api/events` with Bearer auth, error handling |
| `packages/opencode-plugin/src/config.ts` | `loadConfig(env)` from env vars; no secret logging; `MEETLESS_*` surface |
| `packages/opencode-plugin/src/plugin.ts` | `MeetlessPlugin: Plugin` — hooks: `tool.execute.after` + `event` (file.edited); path dedup |
| `packages/opencode-plugin/src/index.ts` | Barrel: re-export normalizer/emitter/config/types/plugin |
| `packages/opencode-plugin/scripts/install.mjs` | Minimal installer — copies built `dist/*` into `.opencode/plugins/` |
| `packages/opencode-plugin/src/types/__tests__` `normalizer` `emitter` `config` `plugin` test files | Unit + integration tests |
| `apps/api/src/__tests__/e2e-opencode.test.ts` | E2E: OpenCode event → plugin → `/api/events` → reconciliation → conflict with Claude |
| `apps/api/scripts/demo-opencode.ts` | Demo: plugin normalizer+emitter → API → conflict with Claude |

### Modified Files

| File | Change |
|------|--------|
| `apps/api/package.json` | Add `@meetless/opencode` dependency (Task 6) + `"demo:opencode"` script (Task 7) |
| `packages/opencode-plugin/package.json` (as new) | Wire `@meetless/opencode` workspace exports for `import { ... } from '@meetless/opencode'` |
| `docs/project-overview.md` | Add OpenCode row to the Available Connectors table |
| `docs/superpowers/plans/phase-2d-opencode-plugin.md` | This plan (tracked) |

> Note: `packages/shared/src/connectors/index.ts` and `packages/shared` are **not** modified. The OpenCode plugin is a standalone workspace package, not a `@meetless/shared` connector, because it must run inside the Bun-based OpenCode server and cannot depend on the Node-oriented shared runtime (see Global Constraints).

---

## Detailed Event Mapping (reference for Tasks 2)

The normalizer is a pure function. The plugin builds an `OpenCodeEventInput` from its hooks, then calls `normalizeOpenCodeEvent(input, { agentId })`.

`OpenCodeEventInput` shape (built defensively by the plugin):

```ts
interface OpenCodeEventInput {
  sessionId: string
  callId?: string                 // from tool.execute.after input.callID
  tool?: string                   // from tool.execute.after input.tool
  args?: Record<string, unknown>  // from tool.execute.after input.args
  filePath?: string               // from file.edited event.path
  outputTitle?: string            // from tool.execute.after output.title
  outputMeta?: string             // from tool.execute.after output.metadata
  eventType: 'tool' | 'file' | 'session' | 'permission'
  timestamp?: number
}
```

Mapping to `NormalizedAgentEvent`:

| OpenCode field | Normalized field / rule |
|----------------|-------------------------|
| `sessionId` (OpenCode `sessionID`) | → `event.sessionId` (opaque string; matches `AgentAction.sessionId`) |
| resolved session agent | → `event.agentId` = `MEETLESS_AGENT_ID` if set, else `opencode-<sessionId.slice(0,8)>` |
| `tool` (`edit`/`write`/`patch`) or eventType `file` | → `event.tool = 'edit_file'` |
| `filePath` or `args.filePath` or `args.path` | → `params.path` |
| `args.content` (string) | → `params.content` |
| `args.patch` (string) → else `outputMeta` (diff-like) | → `params.patch` |
| `callId` | → `event.mcpEventId` (dedup id) |
| connector id | → `'opencode'` |
| connector version | → `'1.0.0'` (from package) |
| `rawMCPEvent` | → the source `OpenCodeEventInput` (best-effort provenance) |
| `result` | omitted (reconciliation only needs content/patch); kept as absent |

Only `edit_file` events are emitted for reconciliation; `session.created`/`session.idle`/`session.deleted` and `permission.*` are intentionally **not** sent (observe-only, keep payload minimal). Unsupported tools / missing path → normalizer returns `null`.

---

## Tasks

### Task 1: Scaffold the `@meetless/opencode` workspace package

**Files:**
- Create: `packages/opencode-plugin/package.json`
- Create: `packages/opencode-plugin/tsconfig.json`
- Create: `packages/opencode-plugin/vitest.config.ts`
- Create: `packages/opencode-plugin/.eslintrc.cjs`

**Interfaces:**
- Consumes: nothing (foundational).
- Produces: installable `@meetless/opencode` npm workspace package usable via `import { normalizeOpenCodeEvent, emitToMeetless, loadConfig, MeetlessPlugin } from '@meetless/opencode'` in later tasks and in `apps/api` tests/demo.

- [ ] **Step 1: Create the package manifest**

```jsonc
// packages/opencode-plugin/package.json
{
  "name": "@meetless/opencode",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./plugin": {
      "types": "./dist/plugin.d.ts",
      "import": "./dist/plugin.js"
    }
  },
  "files": ["dist", "scripts"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "eslint src --ext .ts",
    "install:local": "node scripts/install.mjs"
  },
  "devDependencies": {
    "@opencode-ai/plugin": "latest",
    "@types/node": "^20.11.0",
    "vitest": "^1.3.0"
  }
}
```

Note: `@opencode-ai/plugin` is a **devDependency only**; only its `Plugin` type is imported (type-only, erased at build). The built plugin has zero runtime npm dependencies (it relies on Bun/Node globals `fetch`, `process`, `Date`).

- [ ] **Step 2: Create the TypeScript config**

```jsonc
// packages/opencode-plugin/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true,
    "tsBuildInfoFile": "dist/tsbuildinfo"
  },
  "include": ["src/**/*"],
  "references": []
}
```

- [ ] **Step 3: Create the Vitest config**

```ts
// packages/opencode-plugin/vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [ ] **Step 4: Create the ESLint config**

Follow the sibling package pattern (see `packages/shared/.eslintrc.cjs` and `apps/api/.eslintrc.cjs`): extend the repo-root config so environment, ignores, and `@typescript-eslint/recommended` (which sets `@typescript-eslint/no-unused-vars` to `error` with `argsIgnorePattern: '^_'`) are inherited consistently.

```js
// packages/opencode-plugin/.eslintrc.cjs
module.exports = {
  root: true,
  extends: ['../../.eslintrc.cjs'],
  parserOptions: {
    project: ['./tsconfig.json'],
  },
}
```

- [ ] **Step 5: Verify the package is part of the workspace**

Run: `npm install --workspaces` (from repo root)
Expected: `@meetless/opencode@0.0.0` appears in the workspace link. Then run `npm run build --workspace=@meetless/opencode` — it should compile (empty `src` currently, so a clean no-output success or a `dist` with no files is fine).

- [ ] **Step 6: Commit**

```bash
git add packages/opencode-plugin/package.json packages/opencode-plugin/tsconfig.json packages/opencode-plugin/vitest.config.ts packages/opencode-plugin/.eslintrc.cjs
git commit -m "feat(opencode-plugin): scaffold @meetless/opencode workspace package"
```

---

### Task 2: OpenCode event types and normalizer

**Files:**
- Create: `packages/opencode-plugin/src/types.ts`
- Create: `packages/opencode-plugin/src/normalizer.ts`
- Test: `packages/opencode-plugin/src/__tests__/normalizer.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `type OpenCodeEventInput` (above)
  - `interface NormalizedAgentEvent` (local, structurally identical to `@meetless/shared`'s `AgentAction` + connector fields)
  - `function normalizeOpenCodeEvent(input: OpenCodeEventInput, opts: { connectorId?: string; connectorVersion?: string; agentId?: string }): NormalizedAgentEvent | null`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/opencode-plugin/src/__tests__/normalizer.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from repo root): `npm run test --workspace=@meetless/opencode`
Expected: FAIL with "Cannot find module '../normalizer.js'" (module not yet created).

- [ ] **Step 3: Create the types module**

```ts
// packages/opencode-plugin/src/types.ts
export type OpenCodeEventType = 'tool' | 'file' | 'session' | 'permission'

export interface OpenCodeEventInput {
  sessionId: string
  callId?: string
  tool?: string
  args?: Record<string, unknown>
  filePath?: string
  outputTitle?: string
  outputMeta?: string
  eventType: OpenCodeEventType
  timestamp?: number
}

// Local, structurally identical to @meetless/shared's AgentAction + connector fields,
// so the plugin avoids any runtime dependency on the Node-oriented @meetless/shared config.
export interface NormalizedAgentEvent {
  sessionId: string
  agentId: string
  tool: string
  params: Record<string, unknown>
  result?: Record<string, unknown>
  timestamp: number
  connectorId: string
  connectorVersion: string
  mcpEventId: string
  rawMCPEvent?: unknown
}

export const OPENCODE_EDIT_TOOLS: ReadonlySet<string> = new Set(['edit', 'write', 'patch'])

export const OPENCODE_CONNECTOR_ID = 'opencode'
export const OPENCODE_CONNECTOR_VERSION = '0.0.0'
```

- [ ] **Step 4: Implement the normalizer**

```ts
// packages/opencode-plugin/src/normalizer.ts
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

  const args = input.args ?? {}
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from repo root): `npm run test --workspace=@meetless/opencode -- normalizer`
Expected: PASS (all 9 tests green).

- [ ] **Step 6: Commit**

```bash
git add packages/opencode-plugin/src/types.ts packages/opencode-plugin/src/normalizer.ts packages/opencode-plugin/src/__tests__/normalizer.test.ts
git commit -m "feat(opencode-plugin): add OpenCode event normalizer with tests"
```

---

### Task 3: Emitter — HTTP POST with Bearer auth and error handling

**Files:**
- Create: `packages/opencode-plugin/src/emitter.ts`
- Test: `packages/opencode-plugin/src/__tests__/emitter.test.ts`

**Interfaces:**
- Consumes: `NormalizedAgentEvent` from `./types.js`.
- Produces: `function emitToMeetless(config: EmitterConfig, event: NormalizedAgentEvent): Promise<void>` where `EmitterConfig = { apiBaseUrl: string; apiToken?: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/opencode-plugin/src/__tests__/emitter.test.ts
import { describe, it, expect, vi } from 'vitest'
import http from 'http'
import { AddressInfo } from 'net'
import { emitToMeetless } from '../emitter.js'
import type { NormalizedAgentEvent } from '../types.js'

function startServer(handler: (req: http.IncomingMessage, body: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => { handler(req, raw); res.statusCode = 201; res.end('{}') })
    })
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

const event: NormalizedAgentEvent = {
  sessionId: 'sess-1',
  agentId: 'opencode-sess-1',
  tool: 'edit_file',
  params: { path: 'src/a.ts', content: 'x' },
  timestamp: Date.now(),
  connectorId: 'opencode',
  connectorVersion: '1.0.0',
  mcpEventId: 'call-1',
}

describe('emitToMeetless', () => {
  it('posts the event to /api/events with Bearer token', async () => {
    const port = await startServer((req, body) => {
      expect(req.url).toBe('/api/events')
      expect(req.method).toBe('POST')
      expect(req.headers.authorization).toBe('Bearer abc123')
      const payload = JSON.parse(body)
      expect(payload.sessionId).toBe('sess-1')
      expect(payload.mcpEventId).toBe('call-1')
      expect(payload.params).toEqual({ path: 'src/a.ts', content: 'x' })
      expect('result' in payload).toBe(false)
    })
    await emitToMeetless({ apiBaseUrl: `http://127.0.0.1:${port}`, apiToken: 'abc123' }, event)
  })

  it('omits Authorization header when no token is configured', async () => {
    const port = await startServer((req) => {
      expect(req.headers.authorization).toBeUndefined()
    })
    await emitToMeetless({ apiBaseUrl: `http://127.0.0.1:${port}` }, event)
  })

  it('does not throw on non-2xx response (logs only)', async () => {
    const server = http.createServer((_req, res) => { res.statusCode = 400; res.end('{"error":"Invalid sessionId"}') })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    await expect(emitToMeetless({ apiBaseUrl: `http://127.0.0.1:${port}`, apiToken: 't' }, event)).resolves.toBeUndefined()
    server.close()
  })

  it('does not throw on network error (logs only)', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(emitToMeetless({ apiBaseUrl: 'http://127.0.0.1:1', apiToken: 't' }, event)).resolves.toBeUndefined()
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=@meetless/opencode -- emitter`
Expected: FAIL with missing module (also the last test uses `vi` which needs importing — we will add it in step 4's implementation import, but the test file needs `import { vi } from 'vitest'`; add it in step 1's file).

Note for implementer: the last test references `vi` without importing it — add `import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'` in the test file.

- [ ] **Step 3: Write minimal emitter with its own `vi` fix**

```ts
// packages/opencode-plugin/src/emitter.ts
import type { NormalizedAgentEvent } from './types.js'

export interface EmitterConfig {
  apiBaseUrl: string
  apiToken?: string
}

export async function emitToMeetless(config: EmitterConfig, event: NormalizedAgentEvent): Promise<void> {
  const payload: Record<string, unknown> = {
    sessionId: event.sessionId,
    agentId: event.agentId,
    tool: event.tool,
    params: event.params,
    connectorId: event.connectorId,
    connectorVersion: event.connectorVersion,
    mcpEventId: event.mcpEventId,
  }
  if (event.result !== undefined && event.result !== null) {
    payload.result = event.result
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.apiToken) headers.Authorization = `Bearer ${config.apiToken}`

  try {
    const res = await fetch(`${config.apiBaseUrl}/api/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[opencode-plugin] /api/events returned ${res.status} for event ${event.mcpEventId}: ${text}`)
    }
  } catch (err) {
    console.warn(`[opencode-plugin] failed to forward event ${event.mcpEventId}:`, err)
  }
}
```

- [ ] **Step 4: Fix the emitter test import and re-run**

Update the test file's import line to `import { describe, it, expect, vi } from 'vitest'` (remove unused `beforeEach`/`afterEach` if not used).
Run: `npm run test --workspace=@meetless/opencode -- emitter`
Expected: PASS (4 tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/opencode-plugin/src/emitter.ts packages/opencode-plugin/src/__tests__/emitter.test.ts
git commit -m "feat(opencode-plugin): add Meetless API emitter with Bearer auth"
```

---

### Task 4: Config loader (env, no secret logging) + identity tests

**Files:**
- Create: `packages/opencode-plugin/src/config.ts`
- Test: `packages/opencode-plugin/src/__tests__/config.test.ts`

**Interfaces:**
- Consumes: `EmitterConfig` from `./emitter.js`.
- Produces: `interface PluginConfig { apiBaseUrl: string; apiToken?: string; agentId?: string }` and `function loadConfig(env: Record<string, string | undefined>): PluginConfig`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/opencode-plugin/src/__tests__/config.test.ts
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../config.js'

describe('loadConfig', () => {
  it('reads API base url and token from env', () => {
    const cfg = loadConfig({ MEETLESS_API_BASE_URL: 'https://meetless.example.com', MEETLESS_API_TOKEN: 'sekret' })
    expect(cfg.apiBaseUrl).toBe('https://meetless.example.com')
    expect(cfg.apiToken).toBe('sekret')
  })

  it('allows token and agent id to be absent', () => {
    const cfg = loadConfig({ MEETLESS_API_BASE_URL: 'http://127.0.0.1:3000' })
    expect(cfg.apiToken).toBeUndefined()
    expect(cfg.agentId).toBeUndefined()
  })

  it('defaults base url to http://127.0.0.1:4096 when not provided', () => {
    expect(loadConfig({}).apiBaseUrl).toBe('http://127.0.0.1:4096')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=@meetless/opencode -- config`
Expected: FAIL with missing module.

- [ ] **Step 3: Implement the config loader**

```ts
// packages/opencode-plugin/src/config.ts
import type { EmitterConfig } from './emitter.js'

export interface PluginConfig extends EmitterConfig {
  agentId?: string
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:4096'

export function loadConfig(env: Record<string, string | undefined>): PluginConfig {
  return {
    apiBaseUrl: env.MEETLESS_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    apiToken: env.MEETLESS_API_TOKEN || undefined,
    agentId: env.MEETLESS_AGENT_ID || undefined,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=@meetless/opencode -- config`
Expected: PASS (3 tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/opencode-plugin/src/config.ts packages/opencode-plugin/src/__tests__/config.test.ts
git commit -m "feat(opencode-plugin): add env config loader without secret logging"
```

---

### Task 5: Plugin entry (`MeetlessPlugin`) with hooks and dedup

**Files:**
- Create: `packages/opencode-plugin/src/plugin.ts`
- Create: `packages/opencode-plugin/src/index.ts`
- Test: `packages/opencode-plugin/src/__tests__/plugin.test.ts`
- Create: `packages/opencode-plugin/scripts/install.mjs`

**Interfaces:**
- Consumes: `normalizeOpenCodeEvent`, `emitToMeetless`, `loadConfig` from prior tasks; `import type { Plugin } from '@opencode-ai/plugin'` (type-only).
- Produces: `export const MeetlessPlugin: Plugin` — a plugin function `async ({ client })` returning hooks `{ "tool.execute.after": ..., event: ... }`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/opencode-plugin/src/__tests__/plugin.test.ts
import { describe, it, expect, vi } from 'vitest'
import { MeetlessPlugin, buildInputFromToolHook, buildInputFromFileEvent, dedupePath } from '../plugin.js'

describe('MeetlessPlugin hook adapters', () => {
  it('builds input from tool.execute.after hook args', () => {
    const input = buildInputFromToolHook({
      tool: 'edit',
      sessionID: 'sess-1',
      callID: 'call-1',
      args: { filePath: 'src/a.ts', content: 'x' },
    } as any, { title: 'Edit src/a.ts', metadata: '' } as any)
    expect(input.tool).toBe('edit')
    expect(input.sessionId).toBe('sess-1')
    expect(input.callId).toBe('call-1')
    expect(input.filePath).toBeUndefined()
    expect((input.args as any).filePath).toBe('src/a.ts')
    expect(input.eventType).toBe('tool')
  })

  it('builds input from file.edited event', () => {
    const input = buildInputFromFileEvent({ type: 'file.edited', sessionID: 'sess-1', path: 'src/b.ts' } as any)
    expect(input.eventType).toBe('file')
    expect(input.sessionId).toBe('sess-1')
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
    const hooks = await MeetlessPlugin({ client: { app: { log: vi.fn() } } } as any)
    expect(typeof hooks['tool.execute.after']).toBe('function')
    expect(typeof hooks['event']).toBe('function')
  })

  it('does not emit for non-edit tool.execute.after', async () => {
    const hooks = await MeetlessPlugin({ client: { app: { log: vi.fn() } } } as any)
    const log = vi.fn()
    ;(hooks['tool.execute.after'] as any)({ tool: 'bash', sessionID: 'sess-1', callID: 'c', args: { command: 'ls' } }, { output: '' })
    expect(log).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=@meetless/opencode -- plugin`
Expected: FAIL with missing module.

- [ ] **Step 3: Implement the plugin, adapters, dedup, and barrel**

```ts
// packages/opencode-plugin/src/plugin.ts
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
export function buildInputFromFileEvent(
  event: { type?: string; sessionID?: string; path?: string }
): OpenCodeEventInput {
  return {
    sessionId: String(event.sessionID ?? ''),
    filePath: event.path,
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

export const MeetlessPlugin: Plugin = async (_ctx) => {
  const config = loadConfig(process.env as Record<string, string | undefined>)
  const deduper = new PathDeduper(1000)

  async function forward(existing: OpenCodeEventInput): Promise<void> {
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
      await forward(buildInputFromToolHook(input as any, output as any))
    },
    async event({ event }: { event: { type?: string; sessionID?: string; path?: string } }) {
      if (event?.type === 'file.edited') {
        await forward(buildInputFromFileEvent(event as any))
      }
    },
  }
}
```

```ts
// packages/opencode-plugin/src/index.ts
export { normalizeOpenCodeEvent } from './normalizer.js'
export { emitToMeetless } from './emitter.js'
export type { EmitterConfig } from './emitter.js'
export { loadConfig } from './config.js'
export type { PluginConfig } from './config.js'
export { buildInputFromToolHook, buildInputFromFileEvent, dedupePath, MeetlessPlugin } from './plugin.js'
export type { OpenCodeEventInput, NormalizedAgentEvent } from './types.js'
```

- [ ] **Step 4: Adjust the failing `bash` test to route through the hooks**

The unit test `does not emit for non-edit tool.execute.after` in step 1 does not actually wire `forward`/`emitToMeetless` directly (it expects a `log` spy that the plugin's hooks don't call directly). Replace that test's body with a behaviour assertion on `buildInputFromToolHook` + `normalizeOpenCodeEvent` returning `null`:

```ts
it('non-edit tool.execute.after normalizes to null (no emission)', () => {
  const input = buildInputFromToolHook(
    { tool: 'bash', sessionID: 'sess-1', callID: 'c', args: { command: 'ls' } } as any,
    {} as any
  )
  expect(normalizeOpenCodeEvent(input, { connectorId: 'opencode' })).toBeNull()
})
```

(Add `import { normalizeOpenCodeEvent } from '../normalizer.js'`.)

Optional (recommended for a stronger integration test): mock `emitToMeetless` with `vi.mock` and assert the plugin's `tool.execute.after` callback forwards an `edit` event. Because `MeetlessPlugin` reads `process.env` at load and `emitToMeetless` is imported directly, mock the module:

```ts
vi.mock('../emitter.js', () => ({ emitToMeetless: vi.fn() }))
import { emitToMeetless } from '../emitter.js'
// then:
it('forwards an edit event through the hooks', async () => {
  const hooks = await MeetlessPlugin({ client: { app: { log: vi.fn() } } } as any)
  await hooks['tool.execute.after'](
    { tool: 'edit', sessionID: 'sess-1', callID: 'call-9', args: { filePath: 'src/a.ts', content: 'x' } } as any,
    {} as any
  )
  expect(emitToMeetless).toHaveBeenCalledTimes(1)
})
```

Run: `npm run test --workspace=@meetless/opencode -- plugin`
Expected: PASS.

- [ ] **Step 5: Create the minimal installer**

```js
// packages/opencode-plugin/scripts/install.mjs
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(here, '../dist')
const targetRoot = path.join(os.homedir(), '.config', 'opencode', 'plugins')

fs.mkdirSync(targetRoot, { recursive: true })
const files = ['index.js', 'types.js', 'normalizer.js', 'emitter.js', 'config.js', 'plugin.js']
const written = []
for (const name of files) {
  const src = path.join(dist, name)
  if (fs.existsSync(src)) {
    const dest = path.join(targetRoot, `meetless-${name}`)
    fs.copyFileSync(src, dest)
    written.push(dest)
  }
}
console.log(`[opencode-plugin] copied ${written.length} file(s) to ${targetRoot}`)
```

This is intentionally minimal (no uninstall, no daemon, no dependency resolution). Operators may instead publish the package and reference it via `opencode.json` `"plugin": ["@meetless/opencode"]` — documented in Task 8.

- [ ] **Step 6: Run lint, build, and full workspace tests**

Run: `npm run build --workspace=@meetless/opencode; if ($?) { npm run lint --workspace=@meetless/opencode; if ($?) { npm run test --workspace=@meetless/opencode } }`
Expected: build + lint clean; all unit tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode-plugin/src/plugin.ts packages/opencode-plugin/src/index.ts packages/opencode-plugin/src/__tests__/plugin.test.ts packages/opencode-plugin/scripts/install.mjs
git commit -m "feat(opencode-plugin): add in-process MeetlessPlugin with hooks and dedup"
```

---

### Task 6: E2E — OpenCode event → reconciliation → conflict with Claude

**Files:**
- Test: `apps/api/src/__tests__/e2e-opencode.test.ts`

**Interfaces:**
- Consumes: `buildApp` from `apps/api/src/app.js`, `prisma` from `@meetless/database/client`, `normalizeOpenCodeEvent` + `emitToMeetless` from `@meetless/opencode`.
- Produces: proof that an OpenCode `edit_file` event participates in the same reconciliation session as a Claude event and yields a conflict (mirrors `e2e-cursor-hooks.test.ts`).

- [ ] **Step 1: Prerequisite — register `@meetless/opencode` as an api dependency and build it**

Add to `apps/api/package.json` `dependencies`:

```jsonc
"@meetless/opencode": "*"
```

Then from repo root install and build the plugin package so the api workspace resolves its exports:

```powershell
npm install --workspaces
npm run build --workspace=@meetless/opencode
```

Expected: `npm install` links `@meetless/opencode`, and `tsc` emits `dist/index.js`.

- [ ] **Step 2: Write the failing E2E test**

```ts
// apps/api/src/__tests__/e2e-opencode.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildApp } from '../app.js'
import { prisma } from '@meetless/database/client'
import { normalizeOpenCodeEvent } from '@meetless/opencode'
import type { EmitterConfig } from '@meetless/opencode'

let app: Awaited<ReturnType<typeof buildApp>>
const randSuffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let teamId: string
let userId: string
let workspaceId: string

beforeAll(async () => {
  teamId = (await prisma.team.create({ data: { name: 'OC E2E Team', slug: `oc-e2e-${randSuffix()}` } })).id
  userId = (await prisma.user.create({ data: { clerkId: `clerk_oc_${randSuffix()}`, email: `oc-e2e-${randSuffix()}@example.com` } })).id
  workspaceId = (await prisma.workspace.create({ data: { teamId, name: 'OC E2E Workspace' } })).id

  app = await buildApp()
  await app.ready()
  await app.listen({ port: 0 })
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

beforeEach(async () => {
  await prisma.normalizedEvent.deleteMany()
  await prisma.conflict.deleteMany()
  await prisma.session.deleteMany()
  await prisma.connector.deleteMany()
})

describe('E2E: OpenCode → reconciliation', () => {
  it('OpenCode edit_file event joins the same session and conflicts with Claude', async () => {
    // A Meetless session whose id we choose to match the OpenCode sessionID.
    const sessionId = `oc-e2e-${randSuffix()}`
    await prisma.session.create({
      data: { id: sessionId, workspaceId, userId, name: 'OpenCode Claude Conflict' },
    })

    await prisma.connector.upsert({
      where: { id: 'opencode' }, update: {},
      create: { id: 'opencode', name: 'OpenCode', version: '0.0.0', capabilities: {} },
    })
    await prisma.connector.upsert({
      where: { id: 'claude-code' }, update: {},
      create: { id: 'claude-code', name: 'Claude Code', version: '1.0.0', capabilities: {} },
    })

    const addr = app.server.address()
    if (!addr || typeof addr !== 'object') throw new Error('Server not listening')
    const baseUrl = `http://127.0.0.1:${addr.port}`
    const emitterConfig: EmitterConfig = { apiBaseUrl: baseUrl }

    // Step 1: OpenCode event -> normalize -> emit through the SAME emitter the plugin uses.
    const openCodeEvent = normalizeOpenCodeEvent({
      sessionId,
      callId: `oc-call-${randSuffix()}`,
      tool: 'edit',
      args: { filePath: 'src/app.ts', content: 'function main() { return "OpenCode" }' },
      eventType: 'tool',
    }, { connectorId: 'opencode', connectorVersion: '0.0.0', agentId: 'opencode-agent' })
    expect(openCodeEvent).not.toBeNull()
    await emitToMeetless(emitterConfig, openCodeEvent!)

    // Step 2: Claude edits the SAME file in the SAME session.
    const claudeRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: {
        sessionId,
        agentId: 'claude-1',
        tool: 'edit_file',
        params: { path: 'src/app.ts', content: 'function main() { return "Claude" }' },
        result: { success: true },
        connectorId: 'claude-code',
        connectorVersion: '1.0.0',
        mcpEventId: `claude-oc-${randSuffix()}`,
      },
    })
    expect(claudeRes.statusCode).toBe(201)

    const events = await prisma.normalizedEvent.findMany({ where: { sessionId } })
    expect(events.map((e) => e.connectorId).sort()).toEqual(['claude-code', 'opencode'])

    const conflicts = await prisma.conflict.findMany({ where: { sessionId } })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].file).toBe('src/app.ts')
    expect(conflicts[0].agents).toEqual(expect.arrayContaining(['opencode-agent', 'claude-1']))
    expect(conflicts[0].status).toBe('PENDING')
  })
})
```

- [ ] **Step 3: Run to verify it fails (proves wiring)**

Ensure API test DB is reachable. Run with the correct database URL:
```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
npm run test --workspace=@meetless/api -- e2e-opencode
```
Expected first-run: FAIL if `@meetless/opencode` isn't built (the api test imports it). Before running, `npm run build --workspace=@meetless/opencode`.

- [ ] **Step 4: Make the test pass**

Run: `npm run build --workspace=@meetless/opencode; if ($?) { $env:DATABASE_URL='postgresql://meetless:meetless@localhost:5432/meetless'; npm run test --workspace=@meetless/api -- e2e-opencode }`
Expected: PASS (1 test green), proving OpenCode → plugin → `/api/events` → ingestion → reconciliation, participating in the same session as Claude.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/e2e-opencode.test.ts apps/api/package.json
git commit -m "test(opencode): E2E proof OpenCode participates in cross-connector reconciliation"
```

---

### Task 7: Demo script

**Files:**
- Create: `apps/api/scripts/demo-opencode.ts`
- Modify: `apps/api/package.json` (add `demo:opencode` script)

**Interfaces:**
- Consumes: `buildApp` from `apps/api/src/app.js`, `prisma` from `@prisma/client`, `normalizeOpenCodeEvent` + `emitToMeetless` from `@meetless/opencode`.
- Produces: a runnable `npm run demo:opencode` that shows an OpenCode edit conflicting with a Claude edit.

- [ ] **Step 1: Create the demo script**

```ts
// apps/api/scripts/demo-opencode.ts
#!/usr/bin/env tsx
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../src/app.js'
import { normalizeOpenCodeEvent, emitToMeetless } from '@meetless/opencode'

const prisma = new PrismaClient()

async function main() {
  console.log('=== OpenCode Plugin Connector Demo ===\n')

  const app = await buildApp()
  await app.ready()
  await app.listen({ port: 0 })
  const addr = app.server.address()
  if (!addr || typeof addr !== 'object') throw new Error('Server not listening')
  const port = addr.port
  const baseUrl = `http://127.0.0.1:${port}`
  console.log(`API server running at ${baseUrl}`)

  const team = await prisma.team.create({ data: { name: 'OC Demo Team', slug: `oc-demo-${Date.now()}` } })
  const user = await prisma.user.create({ data: { clerkId: `clerk_oc_${Date.now()}`, email: `oc-demo-${Date.now()}@example.com` } })
  const workspace = await prisma.workspace.create({ data: { teamId: team.id, name: 'OC Demo Workspace' } })
  const session = await prisma.session.create({
    data: { id: `oc-demo-${Date.now()}`, workspaceId: workspace.id, userId: user.id, name: 'OpenCode Demo Session' },
  })
  console.log(`Session created: ${session.id}`)

  console.log('\nAgent A (OpenCode) editing src/app.ts ...')
  const ocEvent = normalizeOpenCodeEvent({
    sessionId: session.id,
    callId: `oc-call-${Date.now()}`,
    tool: 'edit',
    args: { filePath: 'src/app.ts', content: 'function main() { return "OpenCode version" }' },
    eventType: 'tool',
  }, { connectorId: 'opencode', connectorVersion: '0.0.0', agentId: 'opencode-agent' })
  if (!ocEvent) throw new Error('expected opencode event')
  await emitToMeetless({ apiBaseUrl: baseUrl }, ocEvent)
  console.log('OpenCode event ingested')

  console.log('\nAgent B (Claude) editing src/app.ts ...')
  const claudeRes = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.id,
      agentId: 'claude-1',
      tool: 'edit_file',
      params: { path: 'src/app.ts', content: 'function main() { return "Claude version" }' },
      result: { success: true },
      connectorId: 'claude-code',
      connectorVersion: '1.0.0',
      mcpEventId: `claude-demo-${Date.now()}`,
    }),
  })
  console.log(`Claude event ingested (status ${claudeRes.status})`)

  const conflicts = await prisma.conflict.findMany({ where: { sessionId: session.id } })
  console.log(`\nConflicts detected: ${conflicts.length}`)
  for (const c of conflicts) {
    console.log(`  - File: ${c.file}, Agents: ${c.agents.join(', ')}, Status: ${c.status}`)
  }

  const resp = await fetch(`${baseUrl}/api/sessions/${session.id}/conflicts`)
  const apiConflicts = await resp.json() as Array<{ file: string; agents: string[] }>
  console.log(`\nAPI returned ${apiConflicts.length} conflict(s)`)

  await app.close()
  await prisma.$disconnect()
  console.log('\nDemo complete.')
}

main().catch((err) => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Add the demo npm script**

Add to `apps/api/package.json` `"scripts"` (the `@meetless/opencode` dependency was already added in Task 6 Step 1):

```jsonc
"demo:opencode": "npx tsx scripts/demo-opencode.ts"
```

- [ ] **Step 3: Run the demo (verify end-to-end)**

```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
npm run build --workspace=@meetless/opencode
npm run demo:opencode --workspace=@meetless/api
```
Expected: logs show a Session created, OpenCode + Claude events ingested, and `Conflicts detected: 1` (File `src/app.ts`, Agents include `opencode-agent` and `claude-1`).

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/demo-opencode.ts apps/api/package.json
git commit -m "feat(opencode): add demo script for OpenCode plugin connector"
```

---

### Task 8: Documentation + install instructions + project overview

**Files:**
- Modify: `docs/project-overview.md` (add OpenCode row to Available Connectors table)
- Create: `packages/opencode-plugin/README.md` (plugin usage, env vars, install)

**Interfaces:**
- Consumes: earlier tasks' exports.
- Produces: operator-facing docs for loading the plugin into OpenCode (local `.opencode/plugins/` and npm), env configuration, and observe-only scope notes.

- [ ] **Step 1: Add the OpenCode row to the connectors table**

In `docs/project-overview.md`, add to the Available Connectors table:

```markdown
| OpenCode | `opencode` | `edit`, `write`, `patch`, `file.edited` → `edit_file` | ✅ |
```

Confirm this matches the table's column layout (existing rows: connector name, id, tools, support marker). See the Cursor row at line 83 for formatting.

- [ ] **Step 2: Create the plugin README**

```markdown
# @meetless/opencode

In-process OpenCode plugin that observes OpenCode events and forwards normalized file edits to the Meetless ingestion API. **Observe-only** — it does not veto or modify tool execution.

## Architecture

OpenCode loads this plugin inside its server (Bun runtime). It subscribes to:

- `tool.execute.after` — captures `edit`/`write`/`patch` tool calls (tool, session, args, call id)
- `event` (`file.edited`) — captures concrete changed-file paths

Each normalized `edit_file` event is POSTed to `POST /api/events` with the configured bearer token. The Meetless reconciliation engine consumes these events unchanged.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MEETLESS_API_BASE_URL` | no (default `http://127.0.0.1:4096`) | Meetless API base URL |
| `MEETLESS_API_TOKEN` | optional | Bearer token for `/api/events` |
| `MEETLESS_AGENT_ID` | optional | Stable agent id; defaults to `opencode-<session8>` |

Secrets (the token) are read from env and never logged.

## Session identity

OpenCode session ids are opaque and the `/api/events` route requires an existing Meetless `Session.id` (returns 400 for unknown ids). Configure the plugin so its events land in the intended Meetless session: create a Meetless session with `id` equal to the OpenCode session id, or pre-create a session and have the plugin attribute events to it. Cross-session auto-provisioning is a future enhancement.

## Install

### Local (no publish)

```powershell
npm run build --workspace=@meetless/opencode
npm run install:local --workspace=@meetless/opencode   # copies dist/* into ~/.config/opencode/plugins/
```

The copied files are named `meetless-*.js` and are auto-loaded by OpenCode at startup.

### Via npm (recommended for distribution)

Publish the package, then in `opencode.json`:

```json
{ "plugin": ["@meetless/opencode"] }
```

## Important caveats

- The built plugin must stay **self-contained** (no runtime npm deps). Keep `@meetless/opencode` free of Node-only runtime imports that Bun cannot resolve. `@opencode-ai/plugin` is a build-time type only.
- Exact OpenCode event field names (`sessionID`, `path`, `args.filePath`, etc.) follow the documented plugin/SDK shapes; the adapters in `plugin.ts` read them defensively. Re-verify against the installed `@opencode-ai/plugin` types when upgrading OpenCode.
```

- [ ] **Step 3: Add `README.md` to the package files list (so it ships) and link in root**

If publishing, add `"README.md"` to `"files"` in `packages/opencode-plugin/package.json`. (Optional when staying private.)

- [ ] **Step 4: Run the full repo check**

Run: `npm run build; if ($?) { npm run lint }`
Then run the workspace tests (shared, database, api) exactly as the CI does (with `DATABASE_URL` set for api):
```powershell
$env:DATABASE_URL = "postgresql://meetless:meetless@localhost:5432/meetless"
npm run test
```
Expected: build + lint clean; all tests PASS (shared unit tests + api tests including `e2e-opencode.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add docs/project-overview.md packages/opencode-plugin/README.md packages/opencode-plugin/package.json
git commit -m "docs(opencode): add plugin README and project overview connector row"
```

---

## Verification checklist (run after Task 8)

1. `npm run build` — succeeds for all workspaces.
2. `npm run lint` — clean.
3. `npm run test --workspace=@meetless/opencode` — all normalizer/emitter/config/plugin unit tests pass.
4. `$env:DATABASE_URL='postgresql://meetless:meetless@localhost:5432/meetless'; npm run test --workspace=@meetless/api` — `e2e-opencode.test.ts` passes, proving same-session cross-connector conflict with Claude.
5. `npm run demo:opencode --workspace=@meetless/api` — logs one conflict (OpenCode vs Claude).
6. `docs/project-overview.md` shows the `opencode` connector row.
7. Reconciliation engine, events route, Prisma schema, and `@meetless/shared` are **unchanged** in `git status` (all OpenCode logic lives in `packages/opencode-plugin/`).

## Out of scope (future, not planned now)

- `tool.execute.before` enforcement / tool veto / pre-flight conflict prevention.
- Session auto-provisioning from OpenCode's dynamic session ids (requires a generic API change — currently the operator pre-creates the Meetless session).
- OpenCode-as-MCP-server, SQLite polling, transcript monitoring, dashboard, auth/RBAC, advanced rule engine, source-of-truth generator.
