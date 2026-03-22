# MAS Blackboard — Agent Registration Protocol

You are an agent in a multi-agent coordination system. The blackboard YAML file is the shared state. Channels push notifications when the blackboard changes.

## Architecture

```
                  ┌─────────────────────────┐
                  │   BLACKBOARD SERVER      │  ← single process (port 8790)
                  │   blackboard-server.ts   │
                  │                          │
                  │  • Holds shared YAML     │
                  │  • Agent registry        │
                  │  • Dashboard UI          │
                  │  • Broadcasts on change  │
                  └─────┬───────┬───────┬────┘
                        │       │       │
                   HTTP │  HTTP │  HTTP │  (broadcast notifications)
                        │       │       │
                  ┌─────┴──┐ ┌──┴────┐ ┌┴───────┐
                  │ SHIM A │ │SHIM B │ │ SHIM C │  ← thin MCP stdio proxies
                  │ (auto) │ │(auto) │ │ (auto) │
                  └───┬────┘ └──┬────┘ └───┬────┘
                   stdio     stdio      stdio
                      │         │          │
                  Claude A  Claude B   Claude C
```

- **blackboard-server.ts** runs independently as a single shared process
- **blackboard-shim.ts** is spawned by Claude Code per-session (via `.mcp.json`)
- Shims auto-assign a callback port and register with the server
- When any agent writes, the server broadcasts to ALL shims
- Each shim delivers the notification to its Claude session via `<channel>`

## Your Setup

- **Blackboard file**: `blackboard-live.yaml` (owned by the server)
- **Shared server**: `http://localhost:8790` (dashboard + API)
- **Your shim**: auto-connected via `.mcp.json`

## On Startup — Register Yourself

When you start a session in this directory, **immediately**:

1. Use `read_blackboard` to see the current state
2. Use `write_to_blackboard` to register:
   ```
   path: "agents.<your_name>"
   value: {
     role: "<your role — e.g. researcher, coder, reviewer>",
     status: "active",
     registered_at: "<current ISO timestamp>",
     capabilities: ["<what you can do>"]
   }
   log_entry: "<your_name> registered as <role>"
   ```

Pick a unique agent name based on your role or assigned task.

## When You Receive a `<channel>` Notification

This means something changed on the blackboard. Another agent wrote, or a human posted a directive.

1. Use `read_blackboard` to see what changed
2. Check `directives:` for any tasks assigned to you (or to all agents)
3. Do the work requested
4. Use `write_to_blackboard` to:
   - Update your status under `agents.<your_name>.status` (e.g. "working", "done")
   - Record results under `agents.<your_name>.result`
   - Add a log entry describing what you did

## Rules

- **Only write to your own section** under `agents.<your_name>`
- **Never modify** another agent's section
- **Always add a log_entry** when writing to the blackboard
- **Read before writing** — always `read_blackboard` first to avoid stale writes
- All agents share one blackboard — your writes automatically notify everyone

## Directive Protocol

Directives come from humans (via the dashboard) or from a coordinator agent:

```yaml
directives:
  - id: d1234567890
    text: "Research the best approach for X"
    assignee: researcher  # optional — omit means all agents
    status: pending
```

When you complete a directive, update its status by writing to the directives array.

## Launching

```bash
# 1. Start the shared server (one terminal, runs independently)
BLACKBOARD_PORT=8790 bun blackboard-server.ts

# 2. Launch Claude Code sessions (each gets its own shim automatically)
claude --dangerously-load-development-channels server:blackboard-channel
```

Each Claude Code session gets its own shim with an auto-assigned callback port. No port management needed.
