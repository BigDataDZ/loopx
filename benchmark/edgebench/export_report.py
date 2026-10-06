"""Reduce terminal EdgeBench receipts to a portable, settings-bound report.

This adapter reads an explicit run selection, never traverses trajectories, and
reuses benchmark-toolkit run rows. It neither qualifies integrity nor launches
jobs. Source inputs stay private; the export is an allowlisted projection.
"""

from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import json
import math
from pathlib import Path

from loopx.capabilities.benchmark_toolkit.experiment_board import (
    normalize_benchmark_experiment_board_row,
)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path: Path):
    return json.loads(path.read_text())


def write(path: Path, value):
    path.write_text(
        json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    )


def number(value):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise ValueError("Expected a finite numeric observation")
    return value


def csv_write(path, records):
    with path.open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(records[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(records)


def export(runs_root: Path, selection: list, output: Path, *, observed_at: str):
    """Selection is operator-reviewed public settings, not raw launch commands."""
    if output.exists():
        raise ValueError(
            "Use a new output directory; published snapshots are immutable"
        )
    projected, samples, summaries, configs, bindings = [], [], [], {}, []
    seen = set()
    for selected in selection:
        row = normalize_benchmark_experiment_board_row(selected["row"])
        run, case = row["run_id"], row["case_id"]
        if run in seen or any(
            "/" in s or "\\" in s or s in {".", ".."} for s in (run, case)
        ):
            raise ValueError("Unique safe run/case identities required")
        seen.add(run)
        trial = runs_root / run / case
        receipt, profile, final, history = [
            read(trial / name)
            for name in (
                "runtime-receipt.json",
                "worker-profile.json",
                "final_result.json",
                "run_history.json",
            )
        ]
        if receipt["status"] != "terminal" or row["status"] not in {
            "running",
            "completed",
        }:
            raise ValueError("Only terminal, scored runs can be exported")
        for source in (receipt, final):
            if (
                source["run_id"] != run
                or source["task"] != case
                or source["model"] != row["model_id"]
            ):
                raise ValueError("Run identity/model mismatch")
        if history["run_id"] != run or profile["profile"] != receipt["worker"]:
            raise ValueError("History/profile identity mismatch")
        for key, other in (
            ("model", "model"),
            ("effort", "reasoning_effort"),
            ("timeout_seconds", "timeout_seconds"),
            ("feedback", "feedback"),
        ):
            if receipt[key] != profile[other]:
                raise ValueError(f"Profile disagrees with runtime: {key}")
        if row.get("runner_revision") != receipt["runner_commit"]:
            raise ValueError("Board and runner revision disagree")
        if number(final["best_score"]) != number(receipt["best_score"]):
            raise ValueError("Final and runtime scores disagree")
        score_entries = [
            e
            for e in history["entries"]
            if e.get("type") == "submission"
            and e.get("status") == "completed"
            and e.get("score") is not None
        ]
        if (
            not score_entries
            or max(number(e["score"]) for e in score_entries) != final["best_score"]
        ):
            raise ValueError("History does not substantiate best score")
        if len(score_entries) != final["total_rounds"]:
            raise ValueError("Incomplete score history")
        config = copy.deepcopy(selected["settings"])
        # Settings are supplied separately only for facts absent from receipts.
        config.update(
            run_id=run,
            case_id=case,
            arm_id=row["arm_id"],
            attempt=row["attempt"],
            source_study_id=row["study_id"],
            source_benchmark_id=row["benchmark_id"],
            runner={
                key: receipt[key]
                for key in (
                    "worker",
                    "model",
                    "effort",
                    "timeout_seconds",
                    "feedback",
                    "internet",
                    "eval_interval",
                    "submission_cooldown",
                    "loopx_commit",
                    "runner_commit",
                    "task_sha256",
                )
            },
            worker_profile=profile,
        )
        # Do not copy arbitrary profile additions (e.g. future private paths).
        config["worker_profile"] = {
            key: profile[key]
            for key in (
                "profile",
                "model",
                "reasoning_effort",
                "timeout_seconds",
                "stop_hook",
                "outer_resume",
                "explore_graph",
                "explore_harness",
                "feedback",
            )
        }
        row["status"], row["observed_at"] = "completed", observed_at
        row["metrics"]["best_score"] = {
            "value": final["best_score"],
            "unit": "raw_score",
            "higher_is_better": True,
        }
        row["countability"]["official_result_present"] = True
        # Preserve integrity, countability, and insight decisions; never promote.
        row["effort"]["duration_ms"] = round(number(final["runtime_seconds"]) * 1000)
        row = normalize_benchmark_experiment_board_row(row)
        projected.append(row)
        configs[run] = config
        source_hashes = {
            name: digest(trial / name)
            for name in (
                "runtime-receipt.json",
                "worker-profile.json",
                "final_result.json",
                "run_history.json",
            )
        }
        bindings.append({"run_id": run, "source_sha256": source_hashes})
        start = float((trial / "started_at").read_text().splitlines()[1])
        for index, entry in enumerate(score_entries):
            label = entry["round"]
            if (
                not isinstance(label, str)
                or "/" in label
                or "\\" in label
                or label in {".", ".."}
            ):
                raise ValueError("Unsafe sample identity")
            report = trial / "submissions" / label / "report.json"
            elapsed = None
            if report.exists():
                submitted = read(report).get("submitted_at")
                if submitted is not None:
                    elapsed = round(number(submitted) - start, 6)
                    if elapsed < 0:
                        raise ValueError("Sample predates run")
            samples.append(
                {
                    "run_id": run,
                    "sequence": index + 1,
                    "round": label,
                    "elapsed_seconds": elapsed,
                    "score": number(entry["score"]),
                    "valid": entry.get("valid"),
                }
            )
        summaries.append(
            {
                "run_id": run,
                "arm_id": row["arm_id"],
                "benchmark_id": row["benchmark_id"],
                "best_score": final["best_score"],
                "best_round": final["best_round"],
                "runtime_seconds": final["runtime_seconds"],
                "budget_seconds": receipt["timeout_seconds"],
                "total_rounds": final["total_rounds"],
                "agent_submissions": final["agent_submissions"],
                "auto_submissions": final["auto_submissions"],
                "resume_count": final.get("resume_count", 0),
                "timed_out": final["timed_out"],
                "last_observed_score": score_entries[-1]["score"],
                "score_countable": row["countability"]["score_countable"],
            }
        )
    if not seen:
        raise ValueError("Empty selection")
    output.mkdir(parents=True)
    (output / "settings").mkdir()
    write(output / "run-rows.json", projected)
    csv_write(output / "scores.csv", summaries)
    csv_write(output / "samples.csv", samples)
    for binding in bindings:
        run = binding["run_id"]
        name = f"settings/{run}.json"
        write(output / name, configs[run])
        binding.update(settings_file=name, settings_sha256=digest(output / name))
    files = sorted(p for p in output.rglob("*") if p.is_file())
    write(
        output / "index.json",
        {
            "observed_at": observed_at,
            "runs": bindings,
            "files_sha256": {
                p.relative_to(output).as_posix(): digest(p) for p in files
            },
        },
    )
    verify(output)


def verify(directory: Path):
    """Read-only binding validation; hashes do not certify evidence truth/privacy."""
    index = read(directory / "index.json")
    if not {"run-rows.json", "scores.csv", "samples.csv"} <= set(index["files_sha256"]):
        raise ValueError("Missing required data-file binding")
    for name, expected in index["files_sha256"].items():
        path = (directory / name).resolve()
        if not path.is_relative_to(directory.resolve()) or digest(path) != expected:
            raise ValueError(f"File binding failed: {name}")
    rows = [
        normalize_benchmark_experiment_board_row(r)
        for r in read(directory / "run-rows.json")
    ]
    by_run = {r["run_id"]: r for r in rows}
    bindings = index["runs"]
    if (
        len(by_run) != len(rows)
        or len(bindings) != len(rows)
        or {b["run_id"] for b in bindings} != set(by_run)
    ):
        raise ValueError("Every run needs exactly one settings binding")
    for b in bindings:
        if index["files_sha256"].get(b["settings_file"]) != b["settings_sha256"]:
            raise ValueError("Settings digest not bound to file inventory")
        config, row = read(directory / b["settings_file"]), by_run[b["run_id"]]
        for key in ("run_id", "case_id", "arm_id", "attempt"):
            if config[key] != row[key]:
                raise ValueError(f"Settings identity mismatch: {key}")
        if (
            config["runner"]["runner_commit"] != row["runner_revision"]
            or config["runner"]["model"] != row["model_id"]
        ):
            raise ValueError("Settings source/model mismatch")
    with (directory / "scores.csv").open() as stream:
        scores = list(csv.DictReader(stream))
    if len(scores) != len(rows) or {s["run_id"] for s in scores} != set(by_run):
        raise ValueError("Score rows differ from run selection")
    for s in scores:
        if (
            float(s["best_score"])
            != by_run[s["run_id"]]["metrics"]["best_score"]["value"]
        ):
            raise ValueError("Score summary disagrees with canonical row")
    with (directory / "samples.csv").open() as stream:
        samples = list(csv.DictReader(stream))
    if {s["run_id"] for s in samples} != set(by_run):
        raise ValueError("Sample rows differ from run selection")
    for score in scores:
        points = [s for s in samples if s["run_id"] == score["run_id"]]
        if len(points) != int(score["total_rounds"]):
            raise ValueError("Sample count disagrees with summary")
        values = [number(float(p["score"])) for p in points]
        if max(values) != float(score["best_score"]) or values[-1] != float(
            score["last_observed_score"]
        ):
            raise ValueError("Sample scores disagree with summary")
        if len({p["round"] for p in points}) != len(points):
            raise ValueError("Duplicate sample identities")
        if [int(p["sequence"]) for p in points] != list(range(1, len(points) + 1)):
            raise ValueError("Sample order is incomplete")
    return {"runs": len(rows), "files": len(index["files_sha256"]), "verified": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", type=Path)
    parser.add_argument("--runs-root", type=Path)
    parser.add_argument("--selection", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--observed-at")
    args = parser.parse_args()
    if args.verify:
        print(json.dumps(verify(args.verify)))
    else:
        if not all((args.runs_root, args.selection, args.output, args.observed_at)):
            parser.error(
                "Export needs --runs-root, --selection, --output, --observed-at"
            )
        export(
            args.runs_root,
            read(args.selection),
            args.output,
            observed_at=args.observed_at,
        )
        print(json.dumps(verify(args.output)))


if __name__ == "__main__":
    main()
