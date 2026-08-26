# Exponential MCP server

Lets Claude (Claude Code, Claude Desktop, …) work with your Exponential plan: read everything,
plan and update your week, manage tasks and reviews — and edit the master plan only while you
have it unlocked in the app.

## Setup

```bash
cd mcp && npm install
```

Then register it:

- **Claude Code**: `claude mcp add exponential -- node "/path/to/Exponential/mcp/server.mjs"`
- **Claude Desktop**: add to `claude_desktop_config.json`:
  ```json
  { "mcpServers": { "exponential": { "command": "node", "args": ["/path/to/Exponential/mcp/server.mjs"] } } }
  ```

## How auth works

No separate sign-in. On first use the server exchanges the desktop app's Google session for its
own Supabase session (stored as `mcp-session.json` in the app's data folder) which then refreshes
itself. If the first run says it can't start a session, open Exponential once and try again.
Everything runs as **you**, under the same row-level security as the app.

## What Claude can do

- Read: `get_overview`, `get_week`, `get_item`, `search`, `get_retro`
- Week/tasks (always allowed): `create_task`, `update_task` (status, dates, owner, review
  requests), `delete_task` (soft — 7-day trash), `set_notes`
- Master plan (only while the plan is **unlocked** in the app): `create_project`,
  `update_project`, `delete_project`, `create_deadline`, `update_deadline`, `delete_deadline`,
  `create_group`

The current team and the unlock state come from the app (`shared-state.json`), so keep the app
running — or at least recently opened — while Claude works.
