# MAS Blackboard — Channel-Based Multi-Agent Coordination

Coordinate multiple Claude Code sessions through a shared YAML blackboard. One server, N agents, automatic broadcast on every write.

## Architecture

```
                  ┌─────────────────────────┐
                  │   BLACKBOARD SERVER      │  ← single process (port 8790)
                  │   blackboard-server.ts   │
                  │                          │
                  │  • Owns blackboard YAML  │
                  │  • Agent callback registry│
                  │  • Dashboard UI          │
                  │  • Broadcasts on change  │
                  └─────┬───────┬───────┬────┘
                        │       │       │
                   HTTP │  HTTP │  HTTP │  (broadcast notifications)
                        │       │       │
                  ┌─────┴──┐ ┌──┴────┐ ┌┴───────┐
                  │ SHIM A │ │SHIM B │ │ SHIM C │  ← MCP stdio proxies
                  │ (auto) │ │(auto) │ │ (auto) │
                  └───┬────┘ └──┬────┘ └───┬────┘
                   stdio     stdio      stdio
                      │         │          │
                  Claude A  Claude B   Claude C
```

- **blackboard-server.ts** — shared singleton, owns the YAML, broadcasts to all agents
- **blackboard-shim.ts** — thin MCP proxy, spawned per Claude Code session via `.mcp.json`
- Shims auto-assign callback ports and register with the server
- Any write triggers broadcast to ALL connected agents

## Install as Plugin (use from any directory)

For students and users who want the blackboard channel available in any project:

```bash
# 1. Add the marketplace (one time)
claude marketplace add https://raw.githubusercontent.com/balajivis/mas-coordination-demo/main/.claude-plugin/marketplace.json

# 2. Install the plugin (one time)
claude plugin install blackboard-channel@mas-blackboard --scope user
```

Then to use it:

```bash
# Terminal 1: clone and start the shared server
git clone https://github.com/balajivis/mas-coordination-demo.git
cd mas-coordination-demo
bun install
BLACKBOARD_PORT=8790 bun blackboard-server.ts
```

```bash
# Terminal 2: open the dashboard
open http://localhost:8790
```

```bash
# Terminal 3+: launch Claude Code from ANY directory with the channel
cd ~/my-project  # can be any directory
claude --dangerously-load-development-channels plugin:blackboard-channel@mas-blackboard
```

Each session auto-registers with the shared server. Post directives from the dashboard and watch agents coordinate.

## Quick Start (from the repo directly)

If you're working inside the repo itself:

```bash
# Install dependencies (one time)
bun install

# 1. Start the shared blackboard server (keep this terminal open)
BLACKBOARD_PORT=8790 bun blackboard-server.ts

# 2. Open the dashboard
open http://localhost:8790

# 3. In new terminals, launch Claude Code sessions
claude --dangerously-load-development-channels server:blackboard-channel
```

When running from the repo, Claude Code reads `.mcp.json`, spawns `blackboard-shim.ts` as an MCP subprocess, which auto-registers with the shared server. The agent reads `CLAUDE.md`, registers on the blackboard, and starts listening.

## How It Works

1. **Shared server** runs independently on port 8790
2. **Claude Code** spawns a shim per session (configured in `.mcp.json`)
3. **Shim** auto-assigns a callback port, registers with the server
4. **Agent writes** to blackboard via shim → shim POSTs to server → server broadcasts to ALL shims
5. **Each shim** delivers `<channel>` notification to its Claude session
6. **Dashboard** shows live state via WebSocket

The YAML file is the coordination mechanism. HTTP is the transport. Channels are the notification layer.

## How Channels Work

Unlike regular MCP servers, channels declare the `claude/channel` capability, allowing push notifications into agent sessions. The `--dangerously-load-development-channels` flag is required during the research preview to bypass the curated allowlist.

The `server:blackboard-channel` refers to the key in `.mcp.json` (used when running from the repo):

```json
{
  "mcpServers": {
    "blackboard-channel": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start:shim"],
      "env": { "BLACKBOARD_SERVER": "http://127.0.0.1:8790" }
    }
  }
}
```

To load both blackboard and Slack channels simultaneously:

```bash
claude --dangerously-load-development-channels server:blackboard-channel server:slack-channel
```

## MCP Tools (via shim)

| Tool | Description |
|------|-------------|
| `read_blackboard` | Read the full YAML state (or a specific section) |
| `write_to_blackboard` | Write to a dot-path (e.g. `agents.researcher`), notifies all agents |

## Server HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard UI (dark theme, live WebSocket) |
| `/state` | GET | Raw JSON state |
| `/agents` | GET | Registered agent callbacks (debug) |
| `/register` | POST | Shim registers callback port |
| `/unregister` | POST | Shim deregisters on shutdown |
| `/read` | POST | Shim reads blackboard |
| `/write` | POST | Shim writes blackboard (triggers broadcast) |
| `/directive` | POST | Dashboard posts directive (triggers broadcast) |
| `/ws` | WS | Live dashboard updates |

## File Structure

```
mas-coordination-demo/
├── .claude-plugin/
│   ├── plugin.json         # Plugin metadata (for marketplace distribution)
│   └── marketplace.json    # Self-hosted marketplace manifest
├── blackboard-server.ts    # Shared singleton (run independently)
├── blackboard-shim.ts      # Per-agent MCP proxy (spawned by Claude Code)
├── blackboard-channel.ts   # Legacy: monolithic version (kept for reference)
├── blackboard.yaml         # Template (copied to blackboard-live.yaml on first run)
├── .mcp.json               # MCP server config (points to shim)
├── CLAUDE.md               # Agent registration protocol
├── package.json            # Dependencies + scripts
├── docs/                   # Documentation
└── legacy/                 # Old Python control shell
```

## Blackboard Structure

```yaml
blackboard:
  project: mas-coordination-demo
agents:
  researcher:
    role: researcher
    status: active
    registered_at: "2026-03-22T..."
directives:
  - id: d1234567890
    text: "Research the best approach for X"
    assignee: researcher
    status: pending
    posted_at: "2026-03-22T..."
log:
  - ts: "2026-03-22T..."
    entry: "researcher registered"
```

## Background

This implements the classical blackboard architecture (Erman et al., 1980) using MCP channels. The original demo showed how 3 uncoordinated agents produced 601 lines of collectively-broken code. See `docs/POSTMORTEM.md`.

The key insight: the blackboard is a shared singleton, not N copies sharing a file. The server owns the state and broadcasts to all observers — exactly like the original Hearsay-II architecture.
