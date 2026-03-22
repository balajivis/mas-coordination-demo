# MAS Blackboard — Channel-Based Multi-Agent Coordination

Coordinate multiple Claude Code sessions through a shared YAML blackboard. No Python control shell — agents communicate via MCP channels and a shared file.

## How It Works

```
Human (dashboard or editor)
  │ posts directive to blackboard
  │ agents get notified via channels
  ▼
blackboard-live.yaml ← agents read/write via MCP tools
  ▲
  │ write_to_blackboard / read_blackboard
  │
Agent sessions (each with blackboard-channel on a unique port)
  - Register on startup (prompted by CLAUDE.md)
  - Receive <channel> notifications when blackboard changes
  - Read blackboard, do work, write results back
```

The YAML file IS the coordination mechanism. Channels are just the notification layer ("go re-read the file").

## Quick Start

```bash
# Install dependencies (one time)
bun install

# Start the channel server
BLACKBOARD_PORT=8790 bun blackboard-channel.ts

# Open the dashboard
open http://localhost:8790

# In another terminal, launch a Claude Code session with the channel
claude --dangerously-load-development-channels blackboard-channel
```

The agent will read `CLAUDE.md`, register itself on the blackboard, and start listening for directives.

## Multi-Agent Setup

Each agent session needs its own channel server on a unique port:

```bash
# Terminal 1 — agent A
BLACKBOARD_PORT=8790 bun blackboard-channel.ts
# Then: claude --dangerously-load-development-channels blackboard-channel

# Terminal 2 — agent B
BLACKBOARD_PORT=8791 bun blackboard-channel.ts
# Then: claude --dangerously-load-development-channels blackboard-channel

# Terminal 3 — agent C
BLACKBOARD_PORT=8792 bun blackboard-channel.ts
# Then: claude --dangerously-load-development-channels blackboard-channel
```

All agents read/write the same `blackboard-live.yaml`. Post directives from the dashboard on any port.

## MCP Tools

| Tool | Description |
|------|-------------|
| `read_blackboard` | Read the full YAML state (or a specific section) |
| `write_to_blackboard` | Write to a dot-path (e.g. `agents.researcher`), with optional log entry |
| `notify_agent` | POST to another agent's port to trigger a `<channel>` notification |

## HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard UI (dark theme, live WebSocket updates) |
| `/state` | GET | Raw JSON state |
| `/notify` | POST | Trigger a channel notification into this agent session |
| `/directive` | POST | Post a new directive (used by dashboard input bar) |
| `/ws` | WS | WebSocket for live dashboard updates |

## File Structure

```
mas-coordination-demo/
├── blackboard-channel.ts   # MCP server + HTTP + embedded dashboard
├── blackboard.yaml         # Template (copied to blackboard-live.yaml on first run)
├── CLAUDE.md               # Agent registration protocol
├── package.json            # Dependencies
├── docs/
│   ├── POSTMORTEM.md       # Original uncoordinated failure analysis
│   ├── experiment-plan.md  # Original experiment design
│   ├── slack-channel-setup.md
│   └── examples/           # Example blackboard states
└── legacy/
    ├── control_shell.py    # Old Python sequential orchestrator
    ├── blackboard_lib.py   # Old Python blackboard class
    └── agent_prompts.py    # Old Python agent prompts
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

This replaces the sequential Python control shell (`legacy/`) with a channel-based approach. The original demo showed how 3 uncoordinated agents produced 601 lines of collectively-broken code. See `docs/POSTMORTEM.md` for that story.

The key architectural shift: there is no separate orchestrator process. The "control shell" is just another Claude Code agent session with a coordination prompt. All agents are peers communicating through the shared blackboard.
