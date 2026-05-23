#!/usr/bin/env python3
"""PX4 SITL runtime probe harness.

Starts a headless PX4 SITL process when a binary is available, attempts a live
MAVLink heartbeat observation via pymavlink, writes bounded artifacts, and prints
a one-line JSON summary to stdout for the TypeScript runner.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from pymavlink import mavutil
    import pymavlink
except ImportError as exc:
    print(json.dumps({"status": "setup_failed", "error": f"pymavlink import failed: {exc}"}))
    sys.exit(3)


CAVEATS = [
    "This is PX4 runtime probe evidence from a constrained local SITL boot attempt.",
    "This does not prove firmware safety or that any parser-bounds fix holds at runtime.",
    "This is not MAVLink fuzzing or deterministic replay against PX4.",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def truncate_log(text: str, limit: int = 120_000) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... truncated ({len(text) - limit} bytes omitted)\n"


def start_px4(px4_root: Path, px4_binary: Path, runtime_log: Path) -> subprocess.Popen[str]:
    env = os.environ.copy()
    env.setdefault("PX4_SIM_MODEL", "none")
    env.setdefault("PX4_SIM_SPEED_FACTOR", "1")
    log_handle = runtime_log.open("w", encoding="utf-8")
    cmd = [str(px4_binary), "etc/init.d-posix/rcS"]
    proc = subprocess.Popen(
        cmd,
        cwd=str(px4_root),
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        env=env,
        text=True,
    )
    return proc


def observe_mavlink(
    connection: str,
    heartbeat_timeout_sec: float,
) -> dict[str, Any]:
    master = mavutil.mavlink_connection(connection, source_system=255)
    deadline = time.monotonic() + heartbeat_timeout_sec
    last_error: str | None = None
    while time.monotonic() < deadline:
        try:
            msg = master.wait_heartbeat(timeout=1.0)
            if msg is not None:
                return {
                    "heartbeat_observed": True,
                    "system_id": int(msg.get_srcSystem()),
                    "component_id": int(msg.get_srcComponent()),
                    "autopilot": int(msg.autopilot),
                    "type": int(msg.type),
                    "mavlink_version": int(msg.mavlink_version),
                    "connection": connection,
                }
        except Exception as exc:  # noqa: BLE001 - bounded probe loop
            last_error = str(exc)
            time.sleep(0.25)
    return {
        "heartbeat_observed": False,
        "connection": connection,
        "detail": last_error or "No heartbeat before timeout.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="PX4 SITL runtime probe harness")
    parser.add_argument("--artifact-dir", required=True)
    parser.add_argument("--px4-root", required=True)
    parser.add_argument("--px4-binary", required=True)
    parser.add_argument("--mavlink-connection", default="udp:127.0.0.1:14540")
    parser.add_argument("--probe-timeout-sec", type=int, default=60)
    parser.add_argument("--heartbeat-timeout-sec", type=int, default=45)
    parser.add_argument("--pymavlink-version", default="unknown")
    args = parser.parse_args()

    artifact_dir = Path(args.artifact_dir)
    px4_root = Path(args.px4_root)
    px4_binary = Path(args.px4_binary)
    runtime_log = artifact_dir / "runtime.log"

    if not px4_binary.is_file():
        summary = {
            "status": "runtime_unavailable",
            "outcome": "runtime_unavailable",
            "error": f"PX4 binary not found at {px4_binary}",
        }
        write_text(
            artifact_dir / "mavlink-observation.json",
            json.dumps({"observation_possible": False, "reason": summary["error"]}, indent=2) + "\n",
        )
        print(json.dumps(summary))
        return 0

    proc: subprocess.Popen[str] | None = None
    started_at = utc_now()
    probe_deadline = time.monotonic() + float(args.probe_timeout_sec)
    try:
        proc = start_px4(px4_root, px4_binary, runtime_log)
        time.sleep(min(2.0, max(0.0, probe_deadline - time.monotonic())))
        if proc.poll() is not None:
            log_tail = runtime_log.read_text(encoding="utf-8", errors="replace") if runtime_log.exists() else ""
            summary = {
                "status": "runtime_abnormal",
                "outcome": "runtime_abnormal",
                "error": "PX4 process exited before MAVLink observation.",
                "exit_code": proc.returncode,
            }
            write_text(
                artifact_dir / "mavlink-observation.json",
                json.dumps(
                    {
                        "observation_possible": False,
                        "reason": summary["error"],
                        "runtime_log_excerpt": truncate_log(log_tail, 4000),
                    },
                    indent=2,
                )
                + "\n",
            )
            print(json.dumps(summary))
            return 0

        remaining = max(1.0, probe_deadline - time.monotonic())
        heartbeat_timeout = min(float(args.heartbeat_timeout_sec), remaining)
        observation = observe_mavlink(args.mavlink_connection, heartbeat_timeout)
        write_text(artifact_dir / "mavlink-observation.json", json.dumps(observation, indent=2) + "\n")

        if observation.get("heartbeat_observed"):
            summary = {
                "status": "completed",
                "outcome": "runtime_observed",
                "pymavlink_version": args.pymavlink_version,
                "python_version": sys.version.split()[0],
                "px4_binary": str(px4_binary),
                "mavlink_connection": args.mavlink_connection,
                "heartbeat": observation,
                "started_at": started_at,
                "finished_at": utc_now(),
            }
            print(json.dumps(summary))
            return 0

        summary = {
            "status": "runtime_abnormal",
            "outcome": "runtime_abnormal",
            "error": observation.get("detail", "MAVLink heartbeat not observed."),
            "mavlink_connection": args.mavlink_connection,
        }
        print(json.dumps(summary))
        return 0
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc()
        write_text(runtime_log, truncate_log(f"{tb}\n"))
        print(json.dumps({"status": "harness_failed", "error": str(exc), "traceback": tb}))
        return 2
    finally:
        if proc is not None and proc.poll() is None:
            try:
                proc.send_signal(signal.SIGTERM)
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        if runtime_log.exists():
            raw = runtime_log.read_text(encoding="utf-8", errors="replace")
            write_text(runtime_log, truncate_log(raw))


if __name__ == "__main__":
    raise SystemExit(main())
