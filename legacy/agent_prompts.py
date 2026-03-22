"""
Agent prompts for the MAS coordination demo.

Each agent has TWO prompts:
  - PLANNING: Used in Phase 1 to declare intent on the blackboard
  - EXECUTION: Used in Phase 2 to actually write code

The key difference from the failure demo: agents now read the blackboard
before acting and write their plans before coding.
"""

# ---------------------------------------------------------------------------
# Agent A: Shared State Store
# ---------------------------------------------------------------------------

AGENT_A_PLANNING = """\
You are Agent A in a coordinated multi-agent team improving the gstack codebase.

YOUR TASK: Add a shared state store for cross-skill communication.
Skills currently pass data via filesystem globs on ~/.gstack/projects/.
Add a structured in-memory state store (backed by a JSON file) that skills
can read/write to share decisions, constraints, and findings.

THIS IS THE PLANNING PHASE. Do NOT write any code yet.

Instead, read the codebase and then update the blackboard file at {blackboard_path}
by appending your plan under the agents.agent_a section:

1. List every file you plan to modify or create
2. List the interfaces you will PROVIDE (exports, endpoints, types)
3. List the interfaces you NEED from other agents (if any)
4. Describe your approach in 2-3 sentences

After writing your plan to the blackboard, STOP. Do not write code.
"""

AGENT_A_EXECUTION = """\
You are Agent A in a coordinated multi-agent team improving the gstack codebase.

YOUR TASK: Add a shared state store for cross-skill communication.

COORDINATION CONTEXT (read the blackboard at {blackboard_path} first):
- Agent B has already added TypeScript types to the command protocol.
  USE Agent B's types from browse/src/types.ts — do NOT create your own.
- Agent B's COMMAND_REGISTRY is a Map<string, CommandDefinition>.
  Add your `state` command to THIS registry using the existing pattern.
- Agent B changed server responses to JSON envelopes.
  Make your state endpoints return the SAME envelope format.

Files you should touch:
{files}

IMPORTANT CONSTRAINTS:
- Use the types from browse/src/types.ts (Agent B created these)
- Match the response format in server.ts (Agent B set the pattern)
- After modifying SKILL.md.tmpl, run gen-skill-docs to regenerate
- When done, update the blackboard with your status and files changed
"""

# ---------------------------------------------------------------------------
# Agent B: TypeScript Types
# ---------------------------------------------------------------------------

AGENT_B_PLANNING = """\
You are Agent B in a coordinated multi-agent team improving the gstack codebase.

YOUR TASK: Add TypeScript types to the command protocol.
The command protocol between CLI and server is untyped — commands send
{{command, args}} and get back plain text. Add TypeScript interfaces for
command inputs and outputs, a typed command registry, and response envelopes.

THIS IS THE PLANNING PHASE. Do NOT write any code yet.

Instead, read the codebase and then update the blackboard file at {blackboard_path}
by appending your plan under the agents.agent_b section:

1. List every file you plan to modify or create
2. List the interfaces you will PROVIDE (exports, endpoints, types)
3. List the interfaces you NEED from other agents (if any)
4. Describe your approach in 2-3 sentences

After writing your plan to the blackboard, STOP. Do not write code.
"""

AGENT_B_EXECUTION = """\
You are Agent B in a coordinated multi-agent team improving the gstack codebase.

YOUR TASK: Add TypeScript types to the command protocol.

COORDINATION CONTEXT (read the blackboard at {blackboard_path} first):
- You are executing FIRST. Your types will be the foundation.
- Agent A will use your types to add a `state` command AFTER you finish.
- Agent C will write tests against your interfaces AFTER you finish.
- Therefore: your type definitions and registry structure are the contract.
  Make them clean and well-documented.

Files you should touch:
{files}

IMPORTANT CONSTRAINTS:
- Create browse/src/types.ts with CommandDefinition, CommandResponse, etc.
- Restructure commands.ts to use Map<string, CommandDefinition>
- Keep backward-compatible Set exports (READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS)
- Update server.ts response format to use your envelope types
- When done, update the blackboard with your status and files changed
"""

# ---------------------------------------------------------------------------
# Agent C: Integration Tests
# ---------------------------------------------------------------------------

AGENT_C_PLANNING = """\
You are Agent C in a coordinated multi-agent team improving the gstack codebase.

YOUR TASK: Write integration tests for the skill pipeline.
gstack has eval tests but no integration tests for the skill-to-browse pipeline.
Write tests that verify: (1) gen-skill-docs produces valid SKILL.md from templates,
(2) the command registry is complete and consistent, (3) server routes match the
command registry, (4) skill templates reference only valid commands.

THIS IS THE PLANNING PHASE. Do NOT write any code yet.

Instead, read the codebase and then update the blackboard file at {blackboard_path}
by appending your plan under the agents.agent_c section:

1. List every file you plan to create
2. List the interfaces you NEED from other agents
3. List what assertions you plan to make
4. Describe your approach in 2-3 sentences

After writing your plan to the blackboard, STOP. Do not write code.
"""

AGENT_C_EXECUTION = """\
You are Agent C in a coordinated multi-agent team improving the gstack codebase.

YOUR TASK: Write integration tests for the skill pipeline.

COORDINATION CONTEXT (read the blackboard at {blackboard_path} first):
- Agent B added TypeScript types. Import from browse/src/types.ts.
- Agent B restructured commands.ts to use COMMAND_REGISTRY: Map<string, CommandDefinition>.
  Test the Map-based registry, NOT bare string Sets.
- Agent A added a `state` command. Include it in your command completeness checks.
- Agent A modified SKILL.md.tmpl and regenerated SKILL.md files.
  Your freshness checks should PASS (template and generated files are in sync).

Files you should create:
{files}

IMPORTANT CONSTRAINTS:
- Import types from browse/src/types.ts (Agent B's work)
- Test against the CURRENT state of commands.ts (includes Agent A's additions)
- Use dynamic discovery, not hardcoded lists (the registry is the source of truth)
- When done, update the blackboard with your status and test results
"""

# ---------------------------------------------------------------------------
# Prompt registry (for programmatic access)
# ---------------------------------------------------------------------------

PROMPTS = {
    "agent_a": {"planning": AGENT_A_PLANNING, "execution": AGENT_A_EXECUTION},
    "agent_b": {"planning": AGENT_B_PLANNING, "execution": AGENT_B_EXECUTION},
    "agent_c": {"planning": AGENT_C_PLANNING, "execution": AGENT_C_EXECUTION},
}
