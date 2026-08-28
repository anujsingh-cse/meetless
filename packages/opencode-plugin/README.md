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
| `MEETLESS_AGENT_ID` | optional | Stable agent id; defaults to `opencode-<first 8 chars of session id>` |

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
- Exact OpenCode event field names (`sessionID`, `properties.file`, `args.filePath`, etc.) follow the documented plugin/SDK shapes; the adapters in `plugin.ts` read them defensively. Re-verify against the installed `@opencode-ai/plugin` types when upgrading OpenCode.