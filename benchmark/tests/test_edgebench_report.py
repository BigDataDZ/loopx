"""Report portability must not invent qualification or silently swap settings."""

import copy
import json

import pytest

from benchmark.edgebench.export_report import digest, export, verify, write


@pytest.fixture
def trial(tmp_path):
    row = dict(
        schema_version="benchmark_experiment_board_row_v0",
        benchmark_id="example",
        study_id="study",
        case_id="case",
        run_id="run",
        arm_id="baseline",
        arm_role="baseline",
        attempt=1,
        status="running",
        observed_at="2026-01-01T00:00:00+00:00",
        model_id="model",
        protocol_id="protocol",
        comparison_protocol_id="comparison",
        claim_scope="diagnostic_only",
        primary_metric="best_score",
        guardrail_metrics=[],
        metrics={},
        countability=dict(
            integrity_qualified=False,
            official_result_present=False,
            score_countable=False,
        ),
        treatment_fidelity="not_applicable",
        effort={},
        insight=dict(status="pending"),
        runner_revision="abc",
    )
    p = tmp_path / "runs" / "run" / "case"
    p.mkdir(parents=True)
    receipt = dict(
        run_id="run",
        task="case",
        model="model",
        effort="xhigh",
        timeout_seconds=1000,
        worker="single",
        feedback="blind",
        internet=False,
        eval_interval=300,
        submission_cooldown=120,
        loopx_commit="abc",
        runner_commit="abc",
        task_sha256="a" * 64,
        status="terminal",
        best_score=2,
    )
    profile = dict(
        profile="single",
        model="model",
        reasoning_effort="xhigh",
        timeout_seconds=1000,
        stop_hook=False,
        outer_resume=False,
        explore_graph=False,
        explore_harness=False,
        feedback="blind",
        private_future_field="must-not-be-exported",
    )
    final = dict(
        run_id="run",
        task="case",
        model="model",
        best_score=2,
        best_round="auto-1",
        runtime_seconds=800,
        total_rounds=2,
        agent_submissions=0,
        auto_submissions=2,
        timed_out=False,
    )
    history = dict(
        run_id="run",
        entries=[
            dict(type="submission", status="completed", round="auto-1", score=2),
            dict(type="submission", status="completed", round="auto-2", score=0),
        ],
    )
    for name, data in [
        ("runtime-receipt", receipt),
        ("worker-profile", profile),
        ("final_result", final),
        ("run_history", history),
    ]:
        write(p / (name + ".json"), data)
    (p / "started_at").write_text("2026-01-01\n1000\n")
    return (
        tmp_path / "runs",
        [dict(row=row, settings={"unknown": ["random_seed"]})],
        tmp_path / "out",
        p,
    )


def build(trial):
    runs, selection, out, _ = trial
    export(runs, selection, out, observed_at="2026-01-02T00:00:00+00:00")
    return out


def test_terminal_report_retains_unqualified_status_and_unknowns(trial):
    out = build(trial)
    row = json.loads((out / "run-rows.json").read_text())[0]
    assert row["status"] == "completed"
    assert row["metrics"]["best_score"]["value"] == 2
    assert row["countability"] == dict(
        integrity_qualified=False, official_result_present=True, score_countable=False
    )
    assert row["insight"]["status"] == "pending"
    assert "must-not-be-exported" not in (out / "settings/run.json").read_text()
    assert json.loads((out / "settings/run.json").read_text())["unknown"] == [
        "random_seed"
    ]
    assert verify(out)["runs"] == 1
    with pytest.raises(ValueError, match="immutable"):
        build(trial)


@pytest.mark.parametrize(
    "file,key,value",
    [
        ("runtime-receipt", "status", "starting"),
        ("worker-profile", "model", "other"),
        ("runtime-receipt", "runner_commit", "other"),
        ("final_result", "best_score", 3),
        ("run_history", "run_id", "other"),
    ],
)
def test_inconsistent_private_sources_fail_before_output(trial, file, key, value):
    p = trial[3] / (file + ".json")
    data = json.loads(p.read_text())
    data[key] = value
    write(p, data)
    with pytest.raises(ValueError):
        build(trial)
    assert not trial[2].exists()


def test_missing_and_tampered_settings_fail(trial):
    out = build(trial)
    p = out / "settings/run.json"
    original = p.read_bytes()
    p.unlink()
    with pytest.raises((ValueError, FileNotFoundError)):
        verify(out)
    p.write_bytes(original + b" ")
    with pytest.raises(ValueError, match="binding"):
        verify(out)


def test_rehashed_wrong_arm_is_not_accepted(trial):
    out = build(trial)
    p = out / "settings/run.json"
    data = json.loads(p.read_text())
    data["arm_id"] = "wrong"
    write(p, data)
    index = json.loads((out / "index.json").read_text())
    sha = digest(p)
    index["runs"][0]["settings_sha256"] = sha
    index["files_sha256"]["settings/run.json"] = sha
    write(out / "index.json", index)
    with pytest.raises(ValueError, match="identity mismatch"):
        verify(out)


def test_duplicate_selection_fails(trial):
    trial[1].append(copy.deepcopy(trial[1][0]))
    with pytest.raises(ValueError, match="Unique"):
        build(trial)


def test_rehashed_sample_loss_is_not_accepted(trial):
    out = build(trial)
    p = out / "samples.csv"
    p.write_text("\n".join(p.read_text().splitlines()[:2]) + "\n")
    index = json.loads((out / "index.json").read_text())
    index["files_sha256"]["samples.csv"] = digest(p)
    write(out / "index.json", index)
    with pytest.raises(ValueError, match="Sample count"):
        verify(out)


def test_required_file_must_be_in_inventory(trial):
    out = build(trial)
    index = json.loads((out / "index.json").read_text())
    del index["files_sha256"]["run-rows.json"]
    write(out / "index.json", index)
    with pytest.raises(ValueError, match="required"):
        verify(out)
