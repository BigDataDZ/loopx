"""Opt-in qualification with the real native judge, Docker and host firewall.

Run on the Docker Linux host with passwordless iptables sudo:
LOOPX_EDGEBENCH_DOCKER_SMOKE=1 python -m pytest -q <this file>
Requires a locally available python:3.12-slim image. No model calls or task data.
"""
import io
import json
import logging
import os
import socket
import tarfile
import threading
import time
import uuid

import pytest

pytestmark = pytest.mark.skipif(os.environ.get("LOOPX_EDGEBENCH_DOCKER_SMOKE") != "1",
                                reason="Requires explicit isolated Linux Docker qualification")


def wait_for(predicate, timeout=40):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.25)
    raise AssertionError("Synthetic feedback journey did not finish before its deadline")


def test_native_judge_to_isolated_worker_positive_only(tmp_path):
    import docker
    import requests
    import uvicorn
    from sforge.harness.config import SForgeConfig
    from sforge.harness.constants import get_admin_secret
    from sforge.harness.judge_server import create_app
    from sforge.harness.network_isolation import AllowedEndpoint
    from benchmark.edgebench.feedback import BestOnlyFeedback, FEEDBACK_FILE
    from benchmark.runtime.sforge_backend import RecordingDockerBackend

    name = "feedback-smoke-" + uuid.uuid4().hex[:10]
    client = docker.from_env()
    image = client.images.get("python:3.12-slim")
    judge_tag = f"{name}.judge.fixture:fixture"
    image.tag(f"{name}.judge.fixture", tag="fixture")
    tasks = tmp_path / "tasks"
    tasks.mkdir()
    (tasks / "BENCHMARK.yaml").write_text(f"name: {name}\nbase_images: {{python: {{}}}}\n")
    (tasks / "fixture.json").write_text(json.dumps({
        "task_id": "fixture", "name": "Synthetic feedback", "base_image": "python",
        "platform": "linux/arm64", "cwd": "/tmp", "internet": False,
        "submit_paths": ["candidate.json"], "submit_exclude": [],
        "work": {"image_tag": "fixture", "agent_query": "Synthetic fixture"},
        "judge": {"image_tag": "fixture", "eval_timeout": 15, "parser": "structured_json",
                  "selection": "score_first", "score_direction": "maximize",
                  "eval_cmd": "python3 -c 'import json; d=json.load(open(\"candidate.json\")); "
                              "print(json.dumps(dict(score=d[\"value\"], valid=True, "
                              "summary=\"JUDGE_DIAGNOSTIC_SENTINEL\")))'"},
    }))
    config = SForgeConfig(tasks_dir=tasks, log_dir=tmp_path, judge_cpu_limit=1, judge_mem_limit="256m")
    app = create_app(config)
    sock = socket.socket()
    sock.bind(("0.0.0.0", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False))
    server_thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    server_thread.start()
    wait_for(lambda: server.started)
    session = requests.Session()
    session.trust_env = False
    url = f"http://127.0.0.1:{port}"
    secret = get_admin_secret(tmp_path)
    response = session.post(url + "/api/v1/register", json={
        "task_id": "fixture", "run_id": name, "admin_secret": secret,
        "max_agent_submissions": 0}, timeout=5)
    response.raise_for_status()
    token = response.json()["token"]
    trial = tmp_path / "runs" / name / "fixture"
    trial.mkdir(parents=True)
    logger = logging.getLogger(name)
    publisher = BestOnlyFeedback(trial=trial, run_id=name, task_id="fixture", direction="maximize",
                                judge_url=url, admin_secret=secret, logger=logger)
    backend = RecordingDockerBackend(log_dir=trial / "collected", logger=logger, oauth_proxy=True,
                                     blind_api_endpoint=("192.0.2.10", 443), feedback=publisher)
    handle, isolation = None, None
    try:
        handle = backend.create_container(image.id, name, user="root", environment={
            "SFORGE_TOKEN": token, "SFORGE_JUDGE_URL": url})
        backend.start_container(handle)
        gateway = backend.get_container_gateway_ip(handle)
        # A real listening judge is reachable before policy and denied afterward.
        connect = ["python3", "-c", f"import socket; socket.create_connection(('{gateway}', {port}), 1).close()"]
        assert backend.exec_run(handle, connect).exit_code == 0
        isolation = backend.create_network_isolation(handle, [
            AllowedEndpoint(ip=gateway, port=port, hostname="judge"),
            AllowedEndpoint(ip="192.0.2.10", port=443, hostname="fixture-api"),
        ], logger)
        isolation.apply()
        assert backend.exec_run(handle, connect).exit_code != 0
        assert backend.exec_run(handle, ["sh", "-c",
            "test -z \"$SFORGE_TOKEN\" && test -z \"$SFORGE_JUDGE_URL\""]).exit_code == 0
        # Even possession of the host token cannot grant an agent submission.
        denied = session.post(url + "/api/v1/submit", data={"token": token},
                              files={"archive": ("source.tar.gz", b"unused")}, timeout=5)
        assert denied.status_code == 429
        backend.start_feedback(handle)

        def read_packet():
            result = backend.exec_run(handle, ["cat", str(FEEDBACK_FILE)])
            assert result.exit_code == 0
            return json.loads(result.output)

        def submit(value):
            content = json.dumps({"value": value}).encode()
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w:gz") as bundle:
                entry = tarfile.TarInfo("candidate.json")
                entry.size = len(content)
                bundle.addfile(entry, io.BytesIO(content))
            result = session.post(url + "/api/v1/submit", data={
                "token": token, "kind": "auto", "admin_secret": secret},
                files={"archive": ("source.tar.gz", stream.getvalue())}, timeout=5)
            result.raise_for_status()
            identifier = result.json()["submission_id"]
            wait_for(lambda: session.get(url + "/api/v1/result/" + identifier, timeout=5).json()["status"] == "completed")
            return result.json()["round_id"]

        assert read_packet()["latest"] is None
        submit(1)
        wait_for(lambda: publisher.score == 1)
        assert read_packet()["latest"] is None
        winning_round = submit(3)
        wait_for(lambda: publisher.notifications == 1)
        packet = read_packet()
        assert packet["latest"]["snapshot_id"] == winning_round
        assert "JUDGE_DIAGNOSTIC_SENTINEL" not in json.dumps(packet)
        source = backend.exec_run(handle, ["tar", "-xzOf", packet["latest"]["source_archive"], "candidate.json"])
        assert source.exit_code == 0 and json.loads(source.output) == {"value": 3}
        digest = backend.exec_run(handle, ["sha256sum", packet["latest"]["source_archive"]])
        assert digest.output.split()[0] == packet["latest"]["source_sha256"]
        submit(2)
        # Observe a full publisher poll after the regression completes.
        time.sleep(11)
        assert read_packet() == packet and publisher.notifications == 1
        assert publisher.errors == 0
        backend.start_feedback(handle)
        assert read_packet() == packet  # Native resume does not erase the signal.
    finally:
        publisher.close()
        if isolation is not None:
            isolation.cleanup()
        if handle is not None:
            backend.cleanup_container(handle)
        server.should_exit = True
        server_thread.join(timeout=10)
        session.close()
        client.images.remove(judge_tag)
