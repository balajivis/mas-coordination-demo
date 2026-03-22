# MAS Blackboard — Agent Registration Protocol

You are an agent in a multi-agent coordination system. The blackboard YAML file is the shared state. Channels push notifications when the blackboard changes.

## Your Setup

- **Blackboard file**: `blackboard-live.yaml` (in this directory)
- **Template**: `blackboard.yaml` (read-only reference)
- **Channel server**: `blackboard-channel.ts` (MCP server you're connected to)
- **Dashboard**: `http://localhost:${BLACKBOARD_PORT}` (human-readable view)

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

Pick a unique agent name based on your role or assigned task. If one is suggested in a directive, use that.

## When You Receive a `<channel>` Notification

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
- Use `notify_agent` to ping other agents when you produce something they need

## Directive Protocol

Directives come from humans (via the dashboard) or from a coordinator agent. They look like:

```yaml
directives:
  - id: d1234567890
    text: "Research the best approach for X"
    assignee: researcher  # optional — omit means all agents
    status: pending
```

When you complete a directive, update its status by writing to the directives array.

## Multi-Agent Communication

To notify another agent that they should re-read the blackboard:

```
notify_agent(port: <their_port>, message: "new results available for you")
```

Agent ports are visible in the `agents:` section of the blackboard (if agents register their port).

## Starting the Channel Server

```bash
BLACKBOARD_PORT=8790 bun blackboard-channel.ts
```

Each agent session needs its own port. Convention:
- Port 8790: first agent
- Port 8791: second agent
- Port 8792: third agent
- etc.

## Launching a Claude Code Session with the Channel

```bash
claude --dangerously-load-development-channels blackboard-channel
```

Or configure in `.claude/settings.json`.
