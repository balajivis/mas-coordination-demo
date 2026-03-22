# MAS Failure Demo: 3 Agents Break gstack

## The Setup

Three Claude Code agents are given independent improvement tasks on the gstack codebase.
They work in parallel, each on their own branch, with no shared state, no communication,
and no awareness of each other's work.

**Base commit**: `1f4b6fd` (gstack v0.9.4.1)

---

## The Three Agents

### Agent A: "Add a Shared State Store for Cross-Skill Communication"

**Branch**: `agent-a/shared-state`

**Task**: gstack skills currently pass data via filesystem globs on `~/.gstack/projects/`.
Add a structured in-memory state store (backed by a JSON file) that skills can read/write
to share decisions, constraints, and findings. Add browse daemon endpoints for state
get/set, and a new `state` command to the command registry.

**Files it will touch**:
- `browse/src/commands.ts` -- add `state` to command sets
- `browse/src/server.ts` -- add `/state` endpoint
- `browse/src/read-commands.ts` or new `state-commands.ts` -- implement state logic
- `SKILL.md.tmpl` -- document the state commands in skill preamble

**Why it conflicts**: Changes the command registry (single source of truth for the entire
system), adds new server routes, and modifies the template that generates ALL skill docs.

---

### Agent B: "Add TypeScript Types to the Command Protocol"

**Branch**: `agent-b/typed-commands`

**Task**: The command protocol between CLI and server is untyped -- commands send `{command, args}`
and get back plain text. Add TypeScript interfaces for command inputs and outputs, a typed
command registry that replaces the bare string Sets, and response envelope types.

**Files it will touch**:
- `browse/src/commands.ts` -- restructure from Sets to typed registry objects
- `browse/src/server.ts` -- add response types to handleCommand
- `browse/src/read-commands.ts` -- add return type annotations
- `browse/src/write-commands.ts` -- add return type annotations
- New `browse/src/types.ts` -- shared type definitions

**Why it conflicts**: Fundamentally restructures commands.ts, which is imported by server.ts,
gen-skill-docs.ts, skill-parser.ts, and skill-check.ts. Every downstream consumer breaks.

---

### Agent C: "Write Integration Tests for the Skill Pipeline"

**Branch**: `agent-c/skill-tests`

**Task**: gstack has eval tests but no integration tests for the actual skill-to-browse
pipeline. Write tests that verify: (1) gen-skill-docs produces valid SKILL.md from templates,
(2) the command registry is complete and consistent, (3) the server routes match the
command registry, (4) skill templates reference only valid commands.

**Files it will touch**:
- New `test/pipeline-integration.test.ts` -- the test suite
- `browse/src/commands.ts` -- imports for testing
- `browse/src/server.ts` -- imports for testing
- `scripts/gen-skill-docs.ts` -- imports for testing

**Why it conflicts**: Tests are written against the CURRENT API of commands.ts, server.ts,
and gen-skill-docs.ts. Agent A adds new commands. Agent B restructures the exports.
Every test Agent C writes will fail against A's or B's code.

---

## Predicted Failures (by Pillar)

### P1: Shared State & Blackboard
- No shared workspace where agents post their plans before coding
- Agent A doesn't know B is restructuring the same file it needs to modify
- Agent B doesn't know A is adding new commands it should type

### P2: Task Allocation / Contract Net
- Tasks were assigned by a human (us) without agents self-assessing capability
- No agent bid on tasks or declared "this overlaps with my work"
- Better allocation: A and B should be ONE task (add typed state system)

### P4: Result Sharing
- Agent A discovers the command registry has 3 separate Sets (READ, WRITE, META)
- Agent B independently discovers the same thing and decides to restructure it
- Agent C independently reads the same Sets to write assertions
- All three form plans based on the same discovery, none share it

### P5: Communication
- Zero messages between agents
- No way for Agent C to say "hey, what are your final interfaces so I can test them?"
- No way for Agent A to say "I'm adding a `state` command, please include it"

### P6: Conflict Resolution
- When we try to merge branches, git conflicts on commands.ts, server.ts
- No protocol for whose changes take priority
- No mechanism to even DETECT the semantic conflict (A adds untyped commands,
  B is building a typed system -- structurally incompatible)

### P15: Evaluation
- Each agent's work is correct in isolation
- Combined, nothing works
- Standard eval ("does it build?") would pass for each branch independently
  but fail on merge

---

## How to Run the Experiment

### Step 1: Create branches
```bash
cd /Users/bv/Code/active/testbed_mas/gstack
git checkout -b agent-a/shared-state
git checkout main && git checkout -b agent-b/typed-commands
git checkout main && git checkout -b agent-c/skill-tests
git checkout main
```

### Step 2: Run 3 agents in parallel
Launch 3 Claude Code Task agents, each on their own branch, with their task prompt.
They work independently with no shared context.

### Step 3: Collect results
- Diff each branch against main
- Attempt to merge all three into a single branch
- Count conflicts, broken imports, failing tests
- Map each failure to a pillar

### Step 4: The punchline
Show the class:
1. Each agent's work individually (all correct, all builds)
2. The merge attempt (chaos)
3. The 16-pillar diagnosis (what went wrong and why)
4. What would have prevented it (blackboard, result sharing, quality gates)

---

## Workshop Talking Points

1. **"It's not the model."** All three agents used Claude Opus. The model isn't wrong. The coordination is missing.

2. **"gstack has 16,000 stars."** The most popular AI dev tool of the month. And it doesn't have inter-skill coordination either. Same architectural gap.

3. **"Output correct, coordination broken."** Each PR would pass code review individually. Together they destroy the codebase.

4. **"Speed multiplies the damage."** These three agents produced ~500 lines of conflicting code in minutes. A human team would have caught the conflict in a standup. At agent speed, the damage is done before anyone notices.

5. **"Adding more agents makes it worse."** If we added Agent D ("update documentation") and Agent E ("add error handling"), the conflict surface grows superlinearly. Law #1.
