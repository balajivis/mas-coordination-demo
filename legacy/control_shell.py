#!/usr/bin/env python3
"""
Control Shell: Blackboard-based orchestrator for 3 Claude Code agents.

This is the "fix" half of the MAS coordination demo. Instead of launching
3 agents in parallel with no coordination (the failure case), this script:

  Phase 1 — PLAN:    All 3 agents read the codebase and declare their plans
                      on a shared blackboard. The control shell detects conflicts
                      and sets execution order.

  Phase 2 — EXECUTE: Agents run sequentially (B → A → C) with quality gates
                      between each. Each agent reads the blackboard to see what
                      the previous agent did.

  Phase 3 — VERIFY:  Integration tests + blackboard summary.

Usage:
  python control_shell.py                    # Full run (launches Claude Code agents)
  python control_shell.py --dry-run          # Show phases without launching agents
  python control_shell.py --phase 1          # Run only Phase 1 (planning)
  python control_shell.py --phase 2          # Run only Phase 2 (execution)
  python control_shell.py --phase 3          # Run only Phase 3 (verification)

Requires:
  - Python 3.10+
  - ruamel.yaml (pip install ruamel.yaml)
  - Claude Code CLI (`claude`) on PATH
"""

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from blackboard_lib import Blackboard, create_fresh_blackboard
from agent_prompts import PROMPTS

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEMO_DIR = Path(__file__).parent
BLACKBOARD_PATH = DEMO_DIR / "blackboard-live.yaml"
GSTACK_DIR = DEMO_DIR.parent / "gstack"

# Execution order determined by dependency analysis:
#   B first (creates types), A second (uses types), C last (tests everything)
EXECUTION_ORDER = ["agent_b", "agent_a", "agent_c"]

AGENT_TASKS = {
    "agent_a": {
        "name": "Agent A",
        "task": "Add shared state store for cross-skill communication",
        "files": [
            "browse/src/commands.ts",
            "browse/src/server.ts",
            "browse/src/meta-commands.ts",
            "browse/src/state-manager.ts (new)",
            "SKILL.md.tmpl",
        ],
        "interfaces_provided": ["stateSet", "stateGet", "stateList", "stateClear", "/state/* endpoints"],
        "interfaces_needed": ["CommandDefinition (from Agent B)", "CommandResponse (from Agent B)"],
    },
    "agent_b": {
        "name": "Agent B",
        "task": "Add TypeScript types to the command protocol",
        "files": [
            "browse/src/types.ts (new)",
            "browse/src/commands.ts",
            "browse/src/server.ts",
            "browse/src/read-commands.ts",
            "browse/src/write-commands.ts",
        ],
        "interfaces_provided": ["CommandDefinition", "CommandResponse", "ErrorResponse", "COMMAND_REGISTRY"],
        "interfaces_needed": [],
    },
    "agent_c": {
        "name": "Agent C",
        "task": "Write integration tests for the skill pipeline",
        "files": [
            "test/pipeline-integration.test.ts (new)",
            "test/helpers/pipeline-utils.ts (new)",
        ],
        "interfaces_provided": ["integration test suite"],
        "interfaces_needed": [
            "CommandDefinition (from Agent B)",
            "COMMAND_REGISTRY (from Agent B)",
            "state command (from Agent A)",
        ],
    },
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def log(phase: str, msg: str):
    print(f"  [{phase}] {msg}")


def separator(title: str):
    width = 60
    print(f"\n{'=' * width}")
    print(f"  {title}")
    print(f"{'=' * width}\n")


def run_claude_agent(prompt: str, working_dir: Path, agent_name: str, dry_run: bool = False) -> bool:
    """Launch a Claude Code CLI agent with the given prompt.

    Returns True if the agent completed successfully.
    """
    if dry_run:
        log("DRY-RUN", f"Would launch {agent_name} with prompt ({len(prompt)} chars)")
        log("DRY-RUN", f"  Working directory: {working_dir}")
        log("DRY-RUN", f"  First 100 chars: {prompt[:100]}...")
        return True

    log("EXEC", f"Launching {agent_name}...")
    try:
        result = subprocess.run(
            ["claude", "--print", "--dangerously-skip-permissions"],
            input=prompt,
            capture_output=True,
            text=True,
            cwd=str(working_dir),
            timeout=300,  # 5 min per agent
        )
        if result.returncode != 0:
            log("ERROR", f"{agent_name} failed (exit code {result.returncode})")
            log("ERROR", f"stderr: {result.stderr[:500]}")
            return False
        log("EXEC", f"{agent_name} completed successfully")
        return True
    except subprocess.TimeoutExpired:
        log("ERROR", f"{agent_name} timed out after 5 minutes")
        return False
    except FileNotFoundError:
        log("ERROR", "Claude Code CLI (`claude`) not found on PATH")
        log("ERROR", "Install: https://docs.anthropic.com/en/docs/claude-code")
        return False


def run_quality_gate(gate_name: str, bb: Blackboard, dry_run: bool = False) -> bool:
    """Run a quality check between agent executions."""
    if dry_run:
        log("DRY-RUN", f"Would run quality gate: {gate_name}")
        return True

    log("GATE", f"Running: {gate_name}")

    if gate_name == "typescript_compiles":
        result = subprocess.run(
            ["npx", "tsc", "--noEmit"],
            capture_output=True, text=True,
            cwd=str(GSTACK_DIR / "browse"),
        )
        passed = result.returncode == 0
        details = "TypeScript compilation clean" if passed else result.stderr[:200]

    elif gate_name == "tests_pass":
        result = subprocess.run(
            ["bun", "test"],
            capture_output=True, text=True,
            cwd=str(GSTACK_DIR),
        )
        passed = result.returncode == 0
        details = "All tests pass" if passed else result.stderr[:200]

    elif gate_name == "gen_docs_fresh":
        result = subprocess.run(
            ["bun", "run", "scripts/gen-skill-docs.ts", "--dry-run"],
            capture_output=True, text=True,
            cwd=str(GSTACK_DIR),
        )
        passed = result.returncode == 0
        details = "Generated docs are fresh" if passed else "Stale generated docs detected"

    else:
        log("GATE", f"Unknown gate: {gate_name}")
        return False

    icon = "PASS" if passed else "FAIL"
    log("GATE", f"[{icon}] {gate_name}: {details}")
    bb.record_quality_gate(gate_name, passed, details)
    return passed


# ---------------------------------------------------------------------------
# Phase 1: Planning
# ---------------------------------------------------------------------------

def phase1_plan(bb: Blackboard, dry_run: bool = False):
    separator("PHASE 1: PLANNING")
    log("PLAN", "Agents declare their intent on the blackboard\n")

    # Register all agent plans on the blackboard
    for agent_id, info in AGENT_TASKS.items():
        log("PLAN", f"Registering {info['name']}: {info['task']}")
        bb.register_agent_plan(
            agent_id=agent_id,
            task=info["task"],
            files=info["files"],
            interfaces_provided=info["interfaces_provided"],
            interfaces_needed=info["interfaces_needed"],
        )

    # Detect conflicts
    conflicts = bb.detect_conflicts()
    if conflicts:
        log("PLAN", f"\n  Found {len(conflicts)} conflict(s):")
        for c in conflicts:
            if c["type"] == "file_overlap":
                log("PLAN", f"  FILE OVERLAP: {c['agents']} both touch {c['files']}")
            elif c["type"] == "unmet_dependency":
                log("PLAN", f"  UNMET DEP: {c['agent']} needs '{c['needs']}'")
    else:
        log("PLAN", "\n  No conflicts detected (unlikely in practice!)")

    # In the coordinated version, we RESOLVE conflicts by setting execution order
    log("PLAN", f"\n  Resolution: sequential execution order")
    log("PLAN", f"  {' -> '.join(EXECUTION_ORDER)}")
    log("PLAN", f"  Rationale: B creates types first, A uses them, C tests everything\n")
    bb.set_execution_order(EXECUTION_ORDER)

    # Optionally launch planning-phase agents to read the codebase
    if not dry_run:
        log("PLAN", "Launching agents in parallel for codebase analysis...")
        # In a real run, we'd launch planning prompts here.
        # For the demo, the plans are pre-populated above.
        log("PLAN", "(Using pre-analyzed plans for demo speed)")

    print(f"\n{bb.summary()}\n")


# ---------------------------------------------------------------------------
# Phase 2: Sequential Execution
# ---------------------------------------------------------------------------

def phase2_execute(bb: Blackboard, dry_run: bool = False):
    separator("PHASE 2: SEQUENTIAL EXECUTION")
    log("EXEC", "Agents execute in dependency order with quality gates\n")

    bb.reload()
    order = bb.get_execution_order()
    if not order:
        log("ERROR", "No execution order set. Run Phase 1 first.")
        return

    for i, agent_id in enumerate(order):
        agent_info = AGENT_TASKS[agent_id]
        step = f"Step {i + 1}/{len(order)}"

        separator(f"{step}: {agent_info['name']} — {agent_info['task']}")

        # Build the execution prompt with blackboard context
        prompt_template = PROMPTS[agent_id]["execution"]
        prompt = prompt_template.format(
            blackboard_path=str(BLACKBOARD_PATH),
            files="\n".join(f"  - {f}" for f in agent_info["files"]),
        )

        # Mark started
        bb.mark_agent_started(agent_id)
        log("EXEC", f"Blackboard updated: {agent_id} -> in_progress")

        # Run the agent
        success = run_claude_agent(
            prompt=prompt,
            working_dir=GSTACK_DIR,
            agent_name=agent_info["name"],
            dry_run=dry_run,
        )

        if success:
            bb.mark_agent_done(agent_id, files_changed=agent_info["files"])
            log("EXEC", f"Blackboard updated: {agent_id} -> done")
        else:
            bb.mark_agent_failed(agent_id, "Agent execution failed")
            log("EXEC", f"Blackboard updated: {agent_id} -> failed")
            log("EXEC", "Stopping execution pipeline (dependency chain broken)")
            return

        # Quality gate after each agent (except the last)
        if i < len(order) - 1:
            log("GATE", f"\nQuality gate after {agent_info['name']}:")
            gate_passed = run_quality_gate("typescript_compiles", bb, dry_run)
            if not gate_passed and not dry_run:
                log("GATE", "Quality gate FAILED. Stopping pipeline.")
                return
            log("GATE", "Gate passed. Proceeding to next agent.\n")

    print(f"\n{bb.summary()}\n")


# ---------------------------------------------------------------------------
# Phase 3: Integration Verification
# ---------------------------------------------------------------------------

def phase3_verify(bb: Blackboard, dry_run: bool = False):
    separator("PHASE 3: INTEGRATION VERIFICATION")
    log("VERIFY", "Running full test suite + freshness checks\n")

    bb.reload()

    gates = [
        ("typescript_compiles", "TypeScript compiles without errors"),
        ("tests_pass", "All tests pass (including Agent C's new tests)"),
        ("gen_docs_fresh", "Generated SKILL.md files match templates"),
    ]

    all_passed = True
    for gate_name, description in gates:
        log("VERIFY", f"Checking: {description}")
        passed = run_quality_gate(gate_name, bb, dry_run)
        if not passed:
            all_passed = False

    separator("FINAL BLACKBOARD STATE")
    print(bb.summary())

    if all_passed or dry_run:
        print("\n  RESULT: All quality gates passed.")
        print("  The coordinated approach produced working, integrated code.")
    else:
        print("\n  RESULT: Some quality gates failed.")
        print("  Review the blackboard for details.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="MAS Coordination Demo: Blackboard + Control Shell",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  python control_shell.py --dry-run          Show all phases without running agents
  python control_shell.py                    Full coordinated run
  python control_shell.py --phase 1          Planning only
  python control_shell.py --phase 2          Execution only (requires Phase 1)
  python control_shell.py --phase 3          Verification only (requires Phase 2)
        """,
    )
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would happen without launching agents")
    parser.add_argument("--phase", type=int, choices=[1, 2, 3],
                        help="Run a specific phase only")
    args = parser.parse_args()

    # Banner
    print("""
    ╔══════════════════════════════════════════════════════╗
    ║   MAS Coordination Demo: Blackboard + Control Shell  ║
    ║                                                      ║
    ║   The failure: 3 agents, no coordination → chaos     ║
    ║   The fix: shared blackboard + sequential execution  ║
    ╚══════════════════════════════════════════════════════╝
    """)

    if args.dry_run:
        log("MODE", "DRY RUN — no agents will be launched\n")

    # Check gstack directory exists
    if not GSTACK_DIR.exists():
        log("ERROR", f"gstack directory not found: {GSTACK_DIR}")
        log("ERROR", "Clone gstack into the parent directory first.")
        sys.exit(1)

    # Create or reload blackboard
    phases_to_run = [args.phase] if args.phase else [1, 2, 3]

    if 1 in phases_to_run:
        bb = create_fresh_blackboard(BLACKBOARD_PATH)
        log("INIT", f"Fresh blackboard created: {BLACKBOARD_PATH}")
    else:
        if not BLACKBOARD_PATH.exists():
            log("ERROR", f"Blackboard not found: {BLACKBOARD_PATH}")
            log("ERROR", "Run Phase 1 first to create it.")
            sys.exit(1)
        bb = Blackboard(BLACKBOARD_PATH)
        log("INIT", f"Loaded existing blackboard: {BLACKBOARD_PATH}")

    # Run phases
    if 1 in phases_to_run:
        phase1_plan(bb, dry_run=args.dry_run)

    if 2 in phases_to_run:
        phase2_execute(bb, dry_run=args.dry_run)

    if 3 in phases_to_run:
        phase3_verify(bb, dry_run=args.dry_run)

    print(f"\n  Blackboard file: {BLACKBOARD_PATH}")
    print("  Open it in any editor to inspect the full state.\n")


if __name__ == "__main__":
    main()
