"""Transport the explicit Goal cadence to the shared TypeScript history owner."""

from pathlib import Path
from typing import Any


def effective_turn_cadence_context(
    goal: dict[str, Any],
    runtime_root: Path | None,
    *,
    registry_path: Path | None = None,
    goal_ref: dict[str, str] | None = None,
    source_admission: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    profile = goal.get("execution_profile") or {}
    threshold = profile.get("replan_after_effective_turns")
    if threshold is None:
        return None
    if (
        isinstance(threshold, bool)
        or not isinstance(threshold, int)
        or not 1 <= threshold <= 5
    ):
        raise ValueError("replan_after_effective_turns must be an integer from 1 to 5")
    if runtime_root is None or not goal.get("id"):
        raise ValueError("effective Turn cadence requires the Goal settlement runtime")
    if goal_ref is None and goal.get("goal_instance_id"):
        goal_ref = {"goal_id": goal["id"], "goal_instance_id": goal["goal_instance_id"]}
    return {
        "registry_path": registry_path,
        "goal_ref": goal_ref,
        "source_admission": source_admission,
        "threshold": threshold,
        "settlement_source": {
            "runtime_root": str(runtime_root.resolve()),
            "goal_id": goal["id"],
        },
    }
