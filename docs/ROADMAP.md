# Roadmap

## Phase 1: Zero-Clone Server Start

**Problem**: Plugin customers must clone the repo just to run the server. The shim runs from the plugin install, but the server doesn't.

**Goal**: `bunx mas-blackboard-server` starts the server from any directory.

### Steps

1. Publish `mas-blackboard-server` to npm (just `blackboard-server.ts` + `blackboard.yaml` + a bin entry)
2. The server writes `blackboard-live.yaml` to the current working directory (or `~/.mas-blackboard/` if no write perms)
3. Update README: replace the clone-and-run instructions with `bunx mas-blackboard-server`
4. Dashboard still served at `http://localhost:8790`

### Updated 4-Step Customer Flow

```bash
# 1. Start the server (no clone needed)
bunx mas-blackboard-server

# 2. Open dashboard
open http://localhost:8790

# 3. Launch Claude Code from your project
cd ~/my-project
claude --dangerously-load-development-channels plugin:blackboard-channel@mas-blackboard

# 4. Post directive from dashboard, agents coordinate
```

---

## Phase 2: Integrate with kapi-sprints

**Problem**: kapi-sprints has a file-based Markdown blackboard (`board.md` + `entries/`) with a dashboard, skills (`/prd`, `/dev`, `/test`, `/post`), and task management. But it polls every 30s and agents manually check the board for changes. The MAS blackboard has real-time push via MCP channels but no sprint structure.

**Goal**: Use MAS channels as the real-time notification layer for kapi-sprints. Agents get instant `<channel>` pushes when the board changes. The Markdown files remain the source of truth.

### Architecture

```
kapi-sprints dashboard (Next.js)
  │ reads board.md, tasks.md, entries/
  │ POST /api/blackboard/resolve → writes .md files
  ▼
docs/operations/             ← Markdown source of truth
  ├── blackboard/board.md
  ├── blackboard/entries/
  └── sprints/v*/tasks.md
  ▲                           ▲
  │ file watch                │ /post skill writes .md
  │                           │
blackboard-server.ts          Claude agents
  │ detects .md changes       │ receive <channel> notification
  │ broadcasts to all shims   │ read board, do work, write back
  └───────────────────────────┘
```

### Key Design Decision

**Two blackboards, one notification layer:**
- **Markdown** (`board.md`, `entries/`) = source of truth, human-readable, dashboard renders it
- **MCP channels** = real-time push when Markdown changes, agent-to-agent coordination
- No YAML blackboard needed — the server watches the Markdown files and broadcasts on change

### Steps

1. **File watcher in blackboard-server.ts**: Watch `docs/operations/` for `.md` changes. On change, broadcast to all registered shims with the changed file path.

2. **Bridge the /post skill**: When an agent uses `/post blocker "auth is broken"`, the skill writes an entry file + updates board.md. The file watcher picks this up and broadcasts to all agents. Instant notification instead of 30s poll.

3. **Bridge the dashboard**: When a human resolves a decision via the kapi-sprints dashboard (`POST /api/blackboard/resolve`), the file watcher detects the board.md change and broadcasts. Agents learn about resolved decisions immediately.

4. **Update /dev and /prd skills**: Replace the "check the board for blockers" startup step with "wait for `<channel>` notification" — agents react to board changes in real time instead of reading on startup only.

5. **SSE for the kapi-sprints dashboard**: Add a `/events` SSE endpoint to the blackboard server. The kapi-sprints dashboard subscribes and auto-refreshes on change (replacing the 30s poll).

### Config

```typescript
// project.config.ts (kapi-sprints)
export const config = {
  opsDir: '/path/to/project/docs/operations',
  blackboardServer: 'http://localhost:8790',  // new
}
```

```bash
# Start server watching the ops directory
BLACKBOARD_WATCH_DIR=~/Code/active/kapi-platform/docs/operations \
BLACKBOARD_PORT=8790 \
bun blackboard-server.ts
```

### What Changes Where

| File | Change |
|------|--------|
| `blackboard-server.ts` | Add `fs.watch` on `BLACKBOARD_WATCH_DIR`, broadcast on `.md` change |
| `blackboard-shim.ts` | No change (already relays notifications) |
| `kapi-sprints/project.config.ts` | Add `blackboardServer` URL |
| `kapi-sprints/.claude/skills/dev/SKILL.md` | Add channel notification handling |
| `kapi-sprints/.claude/skills/prd/SKILL.md` | Add channel notification handling |
| `kapi-sprints/app/[version]/page.tsx` | Add SSE subscription for live refresh |

---

## Phase 3: Sheridan Autonomy Ramp (from kapi-sprints v2)

**Context**: kapi-sprints v2 plans a competence engine — track human approve/reject/edit decisions per category, compute reliability scores with exponential decay, display review rate targets.

**Integration**: Decision records flow through the MAS channel. When a human approves/rejects via the dashboard, the event broadcasts to all agents. The competence scores live in `board.md` (human-readable) and are parsed by agents to calibrate their autonomy level.

This is a kapi-sprints v2 deliverable, not a mas-coordination-demo deliverable. Listed here for context.
