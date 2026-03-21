# MAS Experiment Post-Mortem: 3 Agents Break gstack

**Date**: 2026-03-21
**Base**: gstack v0.9.4.1 (`1f4b6fd`)
**Model**: Claude Sonnet 4.6 (all three agents)
**Runtime**: ~5 minutes wall clock (parallel execution)

---

## What Happened

Three Claude Code agents were given independent improvement tasks on the gstack
codebase. They ran in parallel, with no shared state, no communication, and no
awareness of each other's work.

### The Agents

| Agent | Task | Files Touched |
|-------|------|---------------|
| **A** | Add shared state store for cross-skill communication | `commands.ts`, `server.ts`, `meta-commands.ts`, new `state-manager.ts`, `SKILL.md.tmpl` |
| **B** | Add TypeScript types to command protocol | `commands.ts`, `server.ts`, `read-commands.ts`, `write-commands.ts`, new `types.ts` |
| **C** | Write integration tests for skill pipeline | new `test/pipeline-integration.test.ts`, new `test/helpers/pipeline-utils.ts` |

### Overlap Map

```
                commands.ts         server.ts        meta-commands.ts
Agent A:    ██████████████████   ████████████████    ██████████████████
Agent B:    ██████████████████   ████████████████
Agent C:          (imports)          (imports)
                 ▲▲▲▲▲▲▲▲              ▲▲▲▲
              3-WAY CONFLICT       3-WAY CONFLICT
```

**Both Agent A and Agent B independently decided to restructure `commands.ts`** from
bare `Set<string>` exports into a `COMMAND_REGISTRY: Map<string, CommandDefinition>`.
They made the same architectural decision independently but with incompatible implementations.

---

## Observed Failures

### 1. Accidental Convergence Without Coordination (P1, P4)

Both Agent A and Agent B independently:
- Created a `types.ts` file (both with `CommandDefinition`)
- Replaced the bare `Set<string>` with `COMMAND_REGISTRY: Map<string, CommandDefinition>`
- Added backward-compatible `READ_COMMANDS` / `WRITE_COMMANDS` / `META_COMMANDS` derived from the registry

**The irony**: They made the *same good decision* independently, duplicating effort.
With a shared blackboard (P1) or result sharing (P4), Agent A would have seen
Agent B's type system and used it instead of creating its own version.

### 2. Last Writer Wins -- Silent Overwrite

Since all agents shared the same working directory:
- Agent B wrote its version of `commands.ts` with its type system
- Agent A then overwrote parts of `commands.ts` with its `state` command additions,
  but built on top of Agent B's restructured version (because B wrote first)
- The final file is a **chimera** -- B's type system with A's state commands grafted on

**If they had been on separate branches** (proper experiment), the merge would
have produced explicit git conflicts. Instead, the sequential-overwrite produced
a file that *looks* coherent but has untested interactions.

### 3. Server Response Format Conflict (P5, P6)

Agent B changed `handleCommand` in `server.ts` to return **JSON envelopes**:
```typescript
{ success: true, data: "...", command: "goto", duration: 42 }
```

Agent A added **REST state endpoints** to the same `server.ts` that return
their own JSON format:
```typescript
// /state/get returns: { key: "skill:key", value: "..." }
// /state/list returns: { keys: ["skill:key1", "skill:key2"] }
```

**The conflict**: Agent A's `state` command (via `handleMetaCommand`) returns
plain text (`"OK: qa:base-url = http://localhost:3000"`). But Agent B wrapped
ALL handleCommand responses in JSON envelopes. So the state command's plain
text is now nested inside `{ success: true, data: "OK: qa:base-url = ..." }`.

Skills reading state output will get a JSON wrapper they don't expect.
**No agent detected this semantic incompatibility.** (P5: no communication, P6: no conflict resolution)

### 4. Test Suite Failures Against Modified Code (P2, P4)

Agent C wrote 46 tests against the codebase. Results:

```
44 pass, 2 fail
```

Failures:
1. **`gen-skill-docs.ts resolvers cover all placeholders`** -- Agent C hardcoded
   the expected list of 1 placeholder. The actual codebase has 16 resolvers.
   Agent C discovered the templates but INCORRECTLY assumed only the ones it
   found in the root template exist. (P4: no result sharing -- if Agent A had
   shared that it modified SKILL.md.tmpl, Agent C would have known)

2. **`skills that read design docs use consistent glob`** -- Agent C's regex
   for valid design-doc glob patterns doesn't match the actual patterns in
   `design-review/SKILL.md`. (P2: wrong task allocation -- Agent C should have
   been assigned AFTER A and B finished, not in parallel)

### 5. Gen-Skill-Docs Freshness Broken

```
gen-skill-docs.test.ts: 99 pass, 5 fail
```

Agent A modified `SKILL.md.tmpl` (added "Shared Skill State" docs) but did
NOT regenerate the SKILL.md files. The freshness check (`--dry-run` comparison)
fails because the template and generated files are now out of sync.

**This cascades**: any skill that uses the stale SKILL.md won't see the state
command documentation.

### 6. Existing Tests Pass But Mask Problems

```
skill-validation.test.ts: 337 pass, 0 fail
```

The existing 337 validation tests all pass! But they only check that each
skill's YAML frontmatter is valid and that command names are consistent.
They don't catch:
- Semantic conflicts between modifications
- The response format change (plain text → JSON envelope)
- The stale template generation
- The duplicate type definitions

**This is the "Output Correct, Coordination Broken" pattern from Pillar 15.**

---

## Failure-to-Pillar Mapping

| # | Failure | Pillar Violated | What Would Have Prevented It |
|---|---------|-----------------|------------------------------|
| 1 | Duplicate `types.ts` + identical `COMMAND_REGISTRY` refactor | P1 (Shared State), P4 (Result Sharing) | Shared blackboard where agents post architectural decisions before coding |
| 2 | Last-writer-wins file overwrite | P1 (Shared State), P3 (Team Design) | File-level locking, or sequential pipeline topology instead of parallel |
| 3 | JSON envelope wrapping state output | P5 (Communication), P6 (Negotiation) | Typed inter-agent messages: "I changed the response format" → B informs A |
| 4 | Tests written against stale API | P2 (Task Allocation), P4 (Result Sharing) | Agent C should wait for A and B to finish (dependency graph), or get live updates |
| 5 | Template modified but not regenerated | P3 (Team Design), P15 (Evaluation) | Quality gate between "modify template" and "ship" steps |
| 6 | Existing tests mask real problems | P15 (Evaluation) | Coordination-level evaluation, not just task-level correctness |

---

## Five Laws Violation Score

| Law | Violated? | Evidence |
|-----|-----------|----------|
| **1. Coordination cost grows superlinearly** | YES | 3 agents × 3 shared files = 9 potential conflicts. Adding a 4th agent would create 12+. |
| **2. Shared state beats message passing** | YES | No shared state at all. Each agent formed its own mental model of the codebase independently. |
| **3. Every handoff needs a quality gate** | YES | No gates between "Agent B restructures commands.ts" and "Agent A adds commands to it." |
| **4. Organization must match problem structure** | YES | Parallel topology for a task with sequential dependencies (B's types should exist before A uses them). |
| **5. Human oversight is a feature** | YES | No human reviewed the combined output. Each agent's individual output looked correct. |

---

## The Punchline (for workshop delivery)

> "Each of these agents used Claude Sonnet 4.6. The model is not the problem.
> Each agent's individual output is well-reasoned, well-coded, and would pass
> code review in isolation.
>
> Combined, they produced:
> - 601 lines of changes across 10 files
> - 2 duplicate implementations of the same idea
> - 1 silent response format conflict
> - 7 failing tests (2 new + 5 existing)
> - 1 stale template that will propagate wrong documentation
>
> In 5 minutes of wall-clock time.
>
> A human team would have caught every one of these conflicts in a 15-minute
> standup. But agents don't have standups. They don't have a shared whiteboard.
> They don't have Slack. They have... nothing.
>
> That's what the 16 pillars fix."

---

## Files Changed (Total)

```
 Modified (6):
   SKILL.md.tmpl                 +25 lines (Agent A)
   browse/src/commands.ts        +414 lines (Agent A + B combined)
   browse/src/meta-commands.ts   +55 lines  (Agent A)
   browse/src/read-commands.ts   +1 line    (Agent B)
   browse/src/server.ts          +105 lines (Agent A + B combined)
   browse/src/write-commands.ts  +1 line    (Agent B)

 Created (4):
   browse/src/state-manager.ts   (Agent A)
   browse/src/types.ts           (Agent B)
   test/helpers/pipeline-utils.ts     (Agent C)
   test/pipeline-integration.test.ts  (Agent C)

 Total: 601 insertions, 97 deletions across 10 files
```
