# MAS Coordination Demo: When 3 AI Agents Break a Codebase (and How to Fix It)

**A teaching demo for the 16 Pillars of Multi-Agent Systems.**

## What This Is

Three Claude Code agents were given independent improvement tasks on a real codebase ([gstack](https://github.com/garrytan/gstack), 16K+ stars). They ran in parallel with no coordination.

**Result: 601 lines of individually-correct, collectively-broken code in 5 minutes.**

This repo contains:
1. **The failure** — documentation of what went wrong and why (postmortem)
2. **The fix** — a blackboard + control shell that coordinates the same 3 tasks
3. **Runnable code** — you can execute the coordinated version yourself

## The Three Agents

| Agent | Task | Key Files |
|-------|------|-----------|
| **A** | Add a shared state store for cross-skill communication | `commands.ts`, `server.ts`, `state-manager.ts` |
| **B** | Add TypeScript types to the command protocol | `types.ts`, `commands.ts`, `server.ts` |
| **C** | Write integration tests for the skill pipeline | `pipeline-integration.test.ts` |

## The Failure (Uncoordinated)

All three agents used Claude Sonnet 4.6. Each agent's individual output was well-reasoned, well-coded, and would pass code review in isolation.

Combined, they produced:

| Metric | Result |
|--------|--------|
| Duplicate implementations | 2 (both A and B independently created `types.ts` and `COMMAND_REGISTRY`) |
| Silent format conflicts | 1 (A's plain text wrapped in B's JSON envelope) |
| Failing tests | 7 (2 new + 5 existing freshness checks) |
| Stale templates | 1 (A modified template but didn't regenerate) |

**The model is not the problem. The coordination is missing.**

> "A human team would have caught every one of these conflicts in a 15-minute standup. But agents don't have standups. They don't have a shared whiteboard. They don't have Slack. They have... nothing. That's what the 16 pillars fix."

See [POSTMORTEM.md](./POSTMORTEM.md) for the full analysis.

## The Fix (Coordinated)

```
┌─────────────────────────────────────────────────────────────┐
│                     CONTROL SHELL                            │
│                                                              │
│  Phase 1: PLAN                                               │
│  ├── All agents declare intent on shared blackboard          │
│  ├── Control shell detects file overlaps                     │
│  ├── Control shell detects unmet interface dependencies      │
│  └── Sets execution order: B → A → C                         │
│                                                              │
│  Phase 2: EXECUTE (sequential, with quality gates)           │
│  ├── Agent B: creates types + registry (foundation)          │
│  │   └── GATE: TypeScript compiles? ✓                        │
│  ├── Agent A: adds state store (uses B's types)              │
│  │   └── GATE: TypeScript compiles? ✓                        │
│  └── Agent C: writes tests (against A+B's combined output)  │
│                                                              │
│  Phase 3: VERIFY                                             │
│  ├── TypeScript compiles? ✓                                  │
│  ├── All tests pass? ✓                                       │
│  └── Generated docs fresh? ✓                                 │
└─────────────────────────────────────────────────────────────┘
```

The blackboard is a YAML file that agents read before acting and write to after acting. It's the shared whiteboard they were missing.

## Pillar Mapping

| Failure | Pillar Violated | How the Fix Prevents It |
|---------|-----------------|-------------------------|
| Duplicate `types.ts` | P1 (Shared State), P4 (Result Sharing) | Blackboard shows B already planned types → A reads before coding |
| Last-writer-wins overwrite | P1, P3 (Team Design) | Sequential execution: B finishes before A starts |
| JSON envelope conflict | P5 (Communication), P6 (Negotiation) | A's prompt includes "match B's envelope format" |
| Tests against stale API | P2 (Task Allocation), P4 | C executes last, tests the actual final state |
| Template not regenerated | P3, P15 (Evaluation) | Quality gate between agents catches stale docs |
| Tests mask problems | P15 | Integration verification in Phase 3 |

## Quick Start

### Prerequisites

- Python 3.10+
- `pip install ruamel.yaml`
- Claude Code CLI ([install](https://docs.anthropic.com/en/docs/claude-code))
- gstack repo in `../gstack/`

### Dry Run (see the phases without launching agents)

```bash
cd mas-coordination-demo
python control_shell.py --dry-run
```

Output shows all three phases, conflict detection, execution order, and quality gates — without actually running Claude Code.

### Full Run

```bash
python control_shell.py
```

This will:
1. Create a fresh `blackboard-live.yaml`
2. Register all agent plans and detect conflicts
3. Launch agents sequentially via Claude Code CLI
4. Run quality gates between each agent
5. Verify the integrated result

### Run Individual Phases

```bash
python control_shell.py --phase 1    # Planning only
python control_shell.py --phase 2    # Execution only (Phase 1 must exist)
python control_shell.py --phase 3    # Verification only (Phase 2 must exist)
```

## File Structure

```
mas-coordination-demo/
├── README.md                  # This file
├── control_shell.py           # The orchestrator (Phase 1/2/3)
├── blackboard_lib.py          # Blackboard class (YAML read/write/conflict-detect)
├── blackboard.yaml            # Empty template (reset state)
├── agent_prompts.py           # All 6 prompts (3 agents × planning + execution)
├── experiment-plan.md         # Original experiment design
├── POSTMORTEM.md              # What went wrong in the uncoordinated run
└── examples/
    ├── blackboard-after-planning.yaml    # What the blackboard looks like after Phase 1
    └── blackboard-after-execution.yaml   # What the blackboard looks like after all 3 phases
```

## The Key Insight

The coordinated run produces **similar code volume** (~550 lines vs 601 lines) but with:

| | Uncoordinated | Coordinated |
|---|---|---|
| Duplicate implementations | 2 | 0 |
| Format conflicts | 1 | 0 |
| Failing tests | 7 | 0 |
| Stale templates | 1 | 0 |
| Wall-clock time | ~5 min | ~8 min |

**The extra 3 minutes bought zero conflicts and zero failures.** Speed without coordination is just faster destruction.

## Classical Roots

This demo implements two patterns from classical multi-agent systems research:

1. **Blackboard Architecture** (Erman et al., 1980) — A shared data structure where knowledge sources (agents) post partial solutions. A control shell decides which source to activate next.

2. **Contract Net Protocol** (Smith, 1980) — Task allocation through announcement → bid → award. Here simplified: the control shell announces tasks, analyzes agent capabilities (what they provide/need), and determines execution order.

The blackboard YAML file IS the blackboard. The `control_shell.py` IS the control shell. The names are literal.

## For the Workshop

1. **Show the postmortem first** — the failure is visceral and memorable
2. **Open `examples/blackboard-after-planning.yaml`** — show how conflict detection works
3. **Run `--dry-run`** — walk through the phases live
4. **Compare the two blackboard examples** — planning vs execution
5. **Ask the class**: "What would happen if we added a 4th agent?" (Answer: coordination cost grows superlinearly — Law #1)
