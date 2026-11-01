# Claude in Wildroom (MCP)

Claude Code and Claude Desktop can drive the app over the [Model Context Protocol](https://modelcontextprotocol.io):
create and open projects, build explainers in one go from a motion-import file, generate pictures, video and sound,
look at the results, arrange and edit the timeline, plan stories with the AI Director, and export. Whatever Claude
makes shows up live in the app.

The MCP server is part of the app's own server, so it runs wherever the app does — `pnpm dev`, `pnpm start` and the
desktop app — at `http://127.0.0.1:<port>/mcp` (Streamable HTTP). Turn it on or off, set the spend cap and copy the
setup snippets in **Settings → Integrations**.

## Connect

Settings → Integrations shows each of these with the paths and token filled in; copy from there.

**Claude Code (recommended: the stdio bridge).** It finds the app on whatever port it got and reads the token itself:

```bash
claude mcp add --scope user wildroom -- node /path/to/wildroom/scripts/studio-mcp.mjs
```

In the desktop app the bridge is inside the app and runs on the app's own Electron
(`ELECTRON_RUN_AS_NODE=1 "/Applications/Wildroom.app/Contents/MacOS/Wildroom" …/app.asar.unpacked/server/studio-mcp.mjs`) —
the snippet in Settings has it.

**Claude Code over HTTP.** Straight to the endpoint; stops working if the app moves to another port:

```bash
claude mcp add --scope user --transport http wildroom http://127.0.0.1:7777/mcp --header "Authorization: Bearer <token>"
```

**Claude Desktop.** Settings → Developer → Edit Config, merge into `claude_desktop_config.json`, restart Claude:

```json
{ "mcpServers": { "wildroom": { "command": "node", "args": ["/path/to/wildroom/scripts/studio-mcp.mjs"] } } }
```

Then ask, for example: *"Make a 30-second explainer about the drama triangle in Wildroom, with a temp
voice-over, and open it in the app."*

## Security

- The server listens on 127.0.0.1 only and checks the `Host` header (no DNS rebinding).
- Every `/mcp` request needs `Authorization: Bearer <token>`. The token is made on first start and kept in the app
  data folder (`~/Library/Application Support/Wildroom/mcp-token`, mode 600); **New token** in Settings
  replaces it. A web page can't send that header cross-site without a CORS preflight, which the server never answers,
  and a request with a foreign `Origin` is refused.
- The app's own API keys never leave the Keychain: the tools say which providers are configured, never the keys.
- Off in Settings → Integrations, every MCP request is refused.

## Money

Nothing paid runs without the user agreeing to its price:

- `generate` with a paid model starts nothing the first time. It answers with the estimate; Claude asks the user and
  calls again with `confirm_usd` set to what they agreed (at least the estimate). A price the table can't estimate is
  counted at the confirmed amount.
- Each MCP session has a **spend cap** (Settings → Integrations, $5 by default): a render that would take the
  session's spend over it is refused even when confirmed. Spend is counted from estimates.
- Free: the demo models (provider `mock`, in demo mode) and models that run on this Mac (`local`), and `temp_voice`
  (a macOS voice). A rented GPU (RunPod) is paid.
- The `director` tool runs the app's text model on the user's API key when one is set (a few cents a call): it needs
  `confirm: true` then. In demo mode with no key it answers from local rules for free.

## Tools

| tool | what it does |
|---|---|
| `studio_status` | demo mode, configured providers, the Director's model, this session's spend and cap |
| `list_projects` · `create_project` · `open_project` | projects (a project is named by id, exact name or `.wildroom` path everywhere) |
| `get_project` | settings, timeline clips (ids, frames, lanes, assets), markers, boards and frames, story in brief; `raw` adds the document |
| `list_assets` · `view_asset` | the project's media; `view_asset` shows Claude a picture or a video frame |
| `import_media` | copies files from this Mac into the project |
| `get_motion_import_guide` · `motion_import` | the [motion-import](motion-import.md) format and the import itself: boards, frames, elements, motion clips, voice-over, markers, brand — one revision |
| `add_to_timeline` | places assets (storyline or lanes, at a frame, after another clip) |
| `edit_timeline` | by clip id: remove, move, trim, blade, speed, clip properties, markers (`POST /api/projects/:id/timeline-ops`) |
| `list_models` · `estimate_cost` · `generate` · `get_job` · `list_jobs` · `cancel_job` | renders; `get_job` waits and shows Claude finished pictures and videos |
| `temp_voice` | a free macOS voice-over for timing |
| `director` · `set_story` | the AI Director (plan, explainer, write_script, outline, scene_shots…) and writing the story into the project |
| `open_in_app` · `export_video` | the app's window opens the project; export renders the timeline to MP4 with the app's own engine |

Every tool calls the app's HTTP API in-process (`src/server/mcp/tools.ts`), so validation, project locking and live
reloads in open editors work as they do for the app's pages.

`open_in_app` and `export_video` need an app window (the desktop app, or a browser tab on `pnpm dev`): the server
sends an `app.request` event, the first window claims it and reports back. Export renders with the page's WebCodecs
engine, so the window must stay open while it runs; the result lands in the project's Assets and the tool answers
with its file path.

## How it fits together

- `src/server/mcp/routes.ts` — `/mcp`: token check, one MCP server and transport per session (JSON responses),
  sessions dropped after 6 h idle; when a session ends, the projects it opened are closed unless an editor has them.
- `src/server/mcp/tools.ts` — the tools; `costGuard.ts` — confirmation and the cap.
- `src/server/services/mcpAccess.ts` — the token and `server.json` (url, port, pid) in the app data folder, written
  once the server listens and removed on a clean quit.
- `scripts/studio-mcp.mjs` — the stdio bridge: no dependencies, reads `server.json` and `mcp-token` for every
  message (so it follows a restart on another port) and sets the session up again after the app restarted.
  `STUDIO_APP_DATA` / `STUDIO_HOME` point it at another app data folder; `STUDIO_MCP_URL` and `STUDIO_MCP_TOKEN`
  override both.
- `src/server/services/appRequests.ts` — `app.request` events to the app's window (open, export).

## Trying it on a scratch server

A server with its own data and no keys (nothing paid can run):

```bash
STUDIO_HOME=/tmp/studio-scratch STUDIO_NO_KEYCHAIN=1 STUDIO_PORT=7792 STUDIO_WEB_PORT=5192 pnpm dev
claude mcp add --scope local studio-scratch -e STUDIO_HOME=/tmp/studio-scratch -- node scripts/studio-mcp.mjs
```

`pnpm test tests/server/mcp.test.ts` covers the endpoint, the token, the tools (an explainer through
`motion_import`, a demo render, the cost guard) and the bridge against such a server.
