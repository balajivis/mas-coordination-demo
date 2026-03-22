"""
Blackboard: a shared YAML file that agents read/write through a control shell.

This is a teaching implementation. In production you'd use Redis, a database,
or a proper blackboard system. Here we use a YAML file because:
1. Students can open it in any editor and watch it change
2. It can be projected on screen during a live demo
3. It maps directly to the classical AI blackboard architecture (Erman et al., 1980)
"""

import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML

yaml = YAML()
yaml.default_flow_style = False
yaml.width = 120


class Blackboard:
    """Read/write/conflict-detect on a shared YAML blackboard."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        if not self.path.exists():
            raise FileNotFoundError(f"Blackboard not found: {self.path}")
        self._load()

    def _load(self):
        with open(self.path) as f:
            self.data = yaml.load(f) or {}

    def _save(self):
        # Atomic write: write to tmp, then rename
        tmp = self.path.with_suffix(".yaml.tmp")
        with open(tmp, "w") as f:
            yaml.dump(self.data, f)
        shutil.move(str(tmp), str(self.path))

    def reload(self):
        """Re-read from disk (another agent may have written)."""
        self._load()

    # --- Phase 1: Planning writes ---

    def register_agent_plan(self, agent_id: str, task: str, files: list[str],
                            interfaces_needed: list[str] | None = None,
                            interfaces_provided: list[str] | None = None):
        """Agent declares what it plans to do before writing any code."""
        if "agents" not in self.data:
            self.data["agents"] = {}
        self.data["agents"][agent_id] = {
            "task": task,
            "status": "planned",
            "files": files,
            "interfaces_provided": interfaces_provided or [],
            "interfaces_needed": interfaces_needed or [],
            "registered_at": _now(),
        }
        self._save()

    def detect_conflicts(self) -> list[dict]:
        """Check all agent plans for file overlaps and unmet interface dependencies."""
        agents = self.data.get("agents", {})
        conflicts = []

        agent_ids = list(agents.keys())
        for i, a_id in enumerate(agent_ids):
            for b_id in agent_ids[i + 1:]:
                a_files = set(agents[a_id].get("files", []))
                b_files = set(agents[b_id].get("files", []))
                overlap = a_files & b_files
                if overlap:
                    conflicts.append({
                        "type": "file_overlap",
                        "agents": [a_id, b_id],
                        "files": sorted(overlap),
                    })

        # Check interface dependencies: does every "needed" have a "provided"?
        all_provided = set()
        for agent in agents.values():
            all_provided.update(agent.get("interfaces_provided", []))

        for a_id, agent in agents.items():
            for needed in agent.get("interfaces_needed", []):
                if needed not in all_provided:
                    conflicts.append({
                        "type": "unmet_dependency",
                        "agent": a_id,
                        "needs": needed,
                    })

        return conflicts

    def set_execution_order(self, order: list[str]):
        """Control shell sets the order agents will execute."""
        self.data["execution_order"] = order
        self.data["execution_order_set_at"] = _now()
        self._save()

    # --- Phase 2: Execution writes ---

    def mark_agent_started(self, agent_id: str):
        self.data["agents"][agent_id]["status"] = "in_progress"
        self.data["agents"][agent_id]["started_at"] = _now()
        self._save()

    def mark_agent_done(self, agent_id: str, files_changed: list[str] | None = None,
                        notes: str | None = None):
        self.data["agents"][agent_id]["status"] = "done"
        self.data["agents"][agent_id]["completed_at"] = _now()
        if files_changed:
            self.data["agents"][agent_id]["files_changed"] = files_changed
        if notes:
            self.data["agents"][agent_id]["notes"] = notes
        self._save()

    def mark_agent_failed(self, agent_id: str, error: str):
        self.data["agents"][agent_id]["status"] = "failed"
        self.data["agents"][agent_id]["failed_at"] = _now()
        self.data["agents"][agent_id]["error"] = error
        self._save()

    # --- Phase 3: Integration writes ---

    def record_quality_gate(self, gate_name: str, passed: bool, details: str = ""):
        if "quality_gates" not in self.data:
            self.data["quality_gates"] = {}
        self.data["quality_gates"][gate_name] = {
            "passed": passed,
            "details": details,
            "checked_at": _now(),
        }
        self._save()

    # --- Read helpers ---

    def get_agent(self, agent_id: str) -> dict | None:
        return self.data.get("agents", {}).get(agent_id)

    def get_execution_order(self) -> list[str]:
        return self.data.get("execution_order", [])

    def summary(self) -> str:
        """Human-readable summary for terminal output."""
        lines = ["=== Blackboard State ==="]
        agents = self.data.get("agents", {})
        if not agents:
            lines.append("  (no agents registered)")
        for a_id, info in agents.items():
            status = info.get("status", "unknown")
            task = info.get("task", "?")
            lines.append(f"  [{status:12s}] {a_id}: {task}")
            files = info.get("files", [])
            if files:
                lines.append(f"               files: {', '.join(files)}")

        order = self.data.get("execution_order")
        if order:
            lines.append(f"\n  Execution order: {' -> '.join(order)}")

        gates = self.data.get("quality_gates", {})
        if gates:
            lines.append("\n  Quality gates:")
            for name, result in gates.items():
                icon = "PASS" if result.get("passed") else "FAIL"
                lines.append(f"    [{icon}] {name}: {result.get('details', '')}")

        return "\n".join(lines)


def create_fresh_blackboard(path: str | Path) -> Blackboard:
    """Create a new empty blackboard YAML file and return a Blackboard instance."""
    path = Path(path)
    initial = {
        "blackboard": {
            "project": "gstack-improvements",
            "created_at": _now(),
            "description": "Shared coordination state for 3 agents improving gstack",
        },
        "agents": {},
    }
    with open(path, "w") as f:
        yaml.dump(initial, f)
    return Blackboard(path)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
