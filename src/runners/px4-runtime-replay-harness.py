#!/usr/bin/env python3
"""PX4 BATTERY_STATUS runtime replay harness.

Boots headless PX4 SITL, delivers a crafted bounds-test BATTERY_STATUS frame via
pymavlink, observes whether PX4 stays up, writes bounded artifacts, and prints a
one-line JSON summary to stdout for the TypeScript runner.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from pymavlink.dialects.v20 import common as dialect
    import pymavlink
    from pymavlink import mavutil
except ImportError as exc:
    print(json.dumps({"status": "setup_failed", "error": f"pymavlink import failed: {exc}"}))
    sys.exit(3)


CAVEATS = [
    "This is one PX4 runtime replay observation against one crafted MAVLink frame.",
    "This does not prove firmware safety or general vulnerability absence.",
    "This does not prove that runtime_anomalous means a vulnerability was found.",
]

SANITIZER_LINE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"==ERROR:\s*AddressSanitizer:"), "asan"),
    (re.compile(r"==ERROR:\s*UndefinedBehaviorSanitizer:"), "ubsan"),
    (re.compile(r"\bruntime error:\s", re.IGNORECASE), "ubsan"),
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


def shrink_runtime_log(path: Path, head_bytes: int = 60_000, tail_bytes: int = 60_000) -> None:
    if not path.exists():
        return
    size = path.stat().st_size
    if size <= head_bytes + tail_bytes:
        return
    with path.open("rb") as handle:
        head = handle.read(head_bytes)
        handle.seek(max(0, size - tail_bytes))
        tail = handle.read(tail_bytes)
    marker = f"\n... runtime.log truncated by harness ({size - head_bytes - tail_bytes} bytes omitted) ...\n".encode(
        "utf-8"
    )
    path.write_bytes(head + marker + tail)


def parse_sanitizer_findings(log_text: str) -> list[dict[str, Any]]:
    """Extract structured ASan/UBSan findings from PX4 combined stdout/stderr."""
    findings: list[dict[str, Any]] = []
    seen_messages: set[str] = set()
    lines = log_text.splitlines()
    for index, line in enumerate(lines):
        for pattern, kind in SANITIZER_LINE_PATTERNS:
            if not pattern.search(line):
                continue
            message = line.strip()
            if message in seen_messages:
                break
            seen_messages.add(message)
            context_start = max(0, index - 1)
            context_end = min(len(lines), index + 4)
            context = "\n".join(lines[context_start:context_end])
            source_location: str | None = None
            for context_line in lines[index : index + 6]:
                location_match = re.search(r"(\S+:\d+:\d+)", context_line)
                if location_match:
                    source_location = location_match.group(1)
                    break
            entry: dict[str, Any] = {
                "kind": kind,
                "message": message,
                "context": truncate_log(context, 2000),
            }
            if source_location:
                entry["source_location"] = source_location
            findings.append(entry)
            break
    return findings


def build_bounds_test_battery_status(mav: dialect.MAVLink) -> tuple[bytes, dict[str, Any]]:
    """Craft a frame whose voltages array fills all 10 slots so PX4's handler loop reaches cell_count==10."""
    voltages = [11000] * 10
    msg = dialect.MAVLink_battery_status_message(
        id=0,
        battery_function=dialect.MAV_BATTERY_FUNCTION_ALL,
        type=dialect.MAV_BATTERY_TYPE_LION,
        temperature=300,
        voltages=voltages,
        current_battery=500,
        current_consumed=1000,
        energy_consumed=500,
        battery_remaining=80,
        time_remaining=3600,
        charge_state=dialect.MAV_BATTERY_CHARGE_STATE_OK,
        voltages_ext=[0, 0, 0, 0],
        mode=dialect.MAV_BATTERY_MODE_UNKNOWN,
        fault_bitmask=0,
    )
    packed = msg.pack(mav)
    record = {
        "seed_id": "bounds-test-battery-status",
        "message_type": "BATTERY_STATUS",
        "dialect": "common",
        "description": (
            "All 10 voltage slots populated with 11000 mV so PX4's handle_message_battery_status "
            "loop reaches cell_count==10, exercising the cell_count<10 guard vs voltages[cell_count] ordering."
        ),
        "voltages": voltages,
        "frame_hex": packed.hex(),
        "frame_length_bytes": len(packed),
        "constructed_at": utc_now(),
    }
    return packed, record


def px4_make_target(px4_root: Path, px4_binary: Path, build_method: str) -> str:
    default_binary = px4_root / "build" / "px4_sitl_default" / "bin" / "px4"
    asan_binary = px4_root / "build" / "px4_sitl_default_asan" / "bin" / "px4"
    resolved_binary = px4_binary.resolve()
    if build_method == "px4_sitl_default_asan" or resolved_binary == asan_binary.resolve():
        if resolved_binary != asan_binary.resolve():
            raise RuntimeError(
                f"Verified PX4 binary {px4_binary} does not match px4_sitl_default_asan launch target {asan_binary}"
            )
        return "px4_sitl_default_asan"
    if resolved_binary != default_binary.resolve():
        raise RuntimeError(
            f"Verified PX4 binary {px4_binary} does not match px4_sitl_default launch target {default_binary}"
        )
    return "px4_sitl_default"


def start_px4(px4_root: Path, px4_binary: Path, runtime_log: Path, build_method: str) -> subprocess.Popen[str]:
    env = os.environ.copy()
    env["PX4_SIM_MODEL"] = "iris"
    env["HEADLESS"] = "1"
    env.setdefault("PX4_SIM_SPEED_FACTOR", "1")
    log_handle = runtime_log.open("w", encoding="utf-8")
    make_target = px4_make_target(px4_root, px4_binary, build_method)
    cmd = ["make", make_target, "jmavsim"]
    if build_method == "px4_asan_make_var":
        cmd.append("PX4_ASAN=1")
    proc = subprocess.Popen(
        cmd,
        cwd=str(px4_root),
        stdin=subprocess.PIPE,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        env=env,
        text=True,
        start_new_session=True,
    )
    return proc


def wait_for_heartbeat(connection: str, timeout_sec: float) -> dict[str, Any]:
    master = mavutil.mavlink_connection(connection, source_system=255, source_component=190)
    deadline = time.monotonic() + timeout_sec
    last_error: str | None = None
    while time.monotonic() < deadline:
        try:
            msg = master.wait_heartbeat(timeout=1.0)
            if msg is not None:
                return {
                    "heartbeat_observed": True,
                    "system_id": int(msg.get_srcSystem()),
                    "component_id": int(msg.get_srcComponent()),
                    "connection": connection,
                    "master": master,
                }
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            time.sleep(0.25)
    return {
        "heartbeat_observed": False,
        "connection": connection,
        "detail": last_error or "No heartbeat before timeout.",
    }


def deliver_frame(master: Any, frame: bytes) -> dict[str, Any]:
    sent_at = utc_now()
    error: str | None = None
    try:
        master.write(frame)
    except Exception as exc:  # noqa: BLE001
        error = str(exc)
    return {
        "sent_at": sent_at,
        "frame_length_bytes": len(frame),
        "delivery_ok": error is None,
        "error": error,
    }


def observe_runtime(
    proc: subprocess.Popen[str],
    runtime_log: Path,
    observation_sec: float,
) -> dict[str, Any]:
    started = time.monotonic()
    time.sleep(observation_sec)
    exit_code = proc.poll()
    log_tail = runtime_log.read_text(encoding="utf-8", errors="replace") if runtime_log.exists() else ""
    abnormal_markers = [
        "segmentation fault",
        "stack trace",
        "fatal",
        "assertion failed",
    ]
    log_lower = log_tail.lower()
    markers = [marker for marker in abnormal_markers if marker in log_lower]
    sanitizer_findings = parse_sanitizer_findings(log_tail)
    px4_still_running = exit_code is None
    return {
        "observation_window_sec": observation_sec,
        "elapsed_sec": round(time.monotonic() - started, 3),
        "px4_still_running": px4_still_running,
        "px4_exit_code": exit_code,
        "runtime_log_markers": markers,
        "sanitizer_findings": sanitizer_findings,
        "runtime_log_excerpt": truncate_log(log_tail, 6000),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="PX4 BATTERY_STATUS runtime replay harness")
    parser.add_argument("--artifact-dir", required=True)
    parser.add_argument("--px4-root", required=True)
    parser.add_argument("--px4-binary", required=True)
    parser.add_argument("--mavlink-connection", default="udp:127.0.0.1:14540")
    parser.add_argument("--replay-timeout-sec", type=int, default=90)
    parser.add_argument("--heartbeat-timeout-sec", type=int, default=45)
    parser.add_argument("--observation-sec", type=int, default=10)
    parser.add_argument("--pymavlink-version", default="unknown")
    parser.add_argument("--build-method", default="unknown")
    parser.add_argument(
        "--prepare-frame-only",
        action="store_true",
        help="Write frame-record artifacts and exit without starting PX4.",
    )
    args = parser.parse_args()

    artifact_dir = Path(args.artifact_dir)
    px4_root = Path(args.px4_root)
    px4_binary = Path(args.px4_binary)
    runtime_log = artifact_dir / "runtime.log"

    mav = dialect.MAVLink(None)
    frame, frame_record = build_bounds_test_battery_status(mav)
    write_text(artifact_dir / "frame-record.json", json.dumps(frame_record, indent=2) + "\n")
    write_text(
        artifact_dir / "frame-record.hex",
        frame_record["frame_hex"] + "\n",
    )

    if args.prepare_frame_only:
        print(json.dumps({"status": "frame_prepared", "frame_seed_id": frame_record["seed_id"]}))
        return 0

    if not px4_binary.is_file():
        summary = {
            "status": "runtime_unavailable",
            "outcome": "runtime_unavailable",
            "error": f"PX4 binary not found at {px4_binary}",
        }
        write_text(
            artifact_dir / "delivery-record.json",
            json.dumps({"delivery_possible": False, "reason": summary["error"]}, indent=2) + "\n",
        )
        write_text(
            artifact_dir / "observation-record.json",
            json.dumps({"observation_possible": False, "reason": summary["error"]}, indent=2) + "\n",
        )
        print(json.dumps(summary))
        return 0

    proc: subprocess.Popen[str] | None = None
    started_at = utc_now()
    replay_deadline = time.monotonic() + float(args.replay_timeout_sec)
    try:
        proc = start_px4(px4_root, px4_binary, runtime_log, args.build_method)
        time.sleep(min(2.0, max(0.0, replay_deadline - time.monotonic())))
        if proc.poll() is not None:
            observation = {
                "observation_possible": False,
                "reason": "PX4 process exited before MAVLink connection.",
                "px4_exit_code": proc.returncode,
            }
            write_text(artifact_dir / "observation-record.json", json.dumps(observation, indent=2) + "\n")
            write_text(
                artifact_dir / "delivery-record.json",
                json.dumps({"delivery_possible": False, "reason": observation["reason"]}, indent=2) + "\n",
            )
            summary = {
                "status": "runtime_unavailable",
                "outcome": "runtime_unavailable",
                "error": observation["reason"],
                "px4_exit_code": proc.returncode,
            }
            print(json.dumps(summary))
            return 0

        remaining = max(1.0, replay_deadline - time.monotonic())
        heartbeat_timeout = min(float(args.heartbeat_timeout_sec), remaining)
        heartbeat = wait_for_heartbeat(args.mavlink_connection, heartbeat_timeout)
        if not heartbeat.get("heartbeat_observed"):
            observation = {
                "observation_possible": False,
                "reason": heartbeat.get("detail", "No MAVLink heartbeat before frame delivery."),
            }
            write_text(artifact_dir / "observation-record.json", json.dumps(observation, indent=2) + "\n")
            write_text(
                artifact_dir / "delivery-record.json",
                json.dumps({"delivery_possible": False, "reason": observation["reason"]}, indent=2) + "\n",
            )
            summary = {
                "status": "runtime_unavailable",
                "outcome": "runtime_unavailable",
                "error": observation["reason"],
            }
            print(json.dumps(summary))
            return 0

        master = heartbeat["master"]
        delivery = deliver_frame(master, frame)
        delivery["mavlink_connection"] = args.mavlink_connection
        delivery["target_system"] = heartbeat.get("system_id")
        delivery["target_component"] = heartbeat.get("component_id")
        write_text(artifact_dir / "delivery-record.json", json.dumps(delivery, indent=2) + "\n")

        if not delivery.get("delivery_ok"):
            observation = {
                "observation_possible": False,
                "reason": delivery.get("error", "Frame delivery failed."),
            }
            write_text(artifact_dir / "observation-record.json", json.dumps(observation, indent=2) + "\n")
            summary = {
                "status": "runtime_unavailable",
                "outcome": "runtime_unavailable",
                "error": observation["reason"],
            }
            print(json.dumps(summary))
            return 0

        remaining = max(1.0, replay_deadline - time.monotonic())
        observation_window = min(float(args.observation_sec), remaining)
        observation = observe_runtime(proc, runtime_log, observation_window)
        observation["frame_delivered"] = True
        observation["delivery_at"] = delivery.get("sent_at")
        write_text(artifact_dir / "observation-record.json", json.dumps(observation, indent=2) + "\n")

        sanitizer_findings = observation.get("sanitizer_findings") or []
        anomalous = (
            not observation.get("px4_still_running")
            or observation.get("px4_exit_code") not in (None, 0)
            or len(observation.get("runtime_log_markers") or []) > 0
            or len(sanitizer_findings) > 0
        )
        outcome = "runtime_anomalous" if anomalous else "runtime_clean"
        summary = {
            "status": "completed",
            "outcome": outcome,
            "pymavlink_version": args.pymavlink_version,
            "python_version": sys.version.split()[0],
            "px4_binary": str(px4_binary),
            "mavlink_connection": args.mavlink_connection,
            "frame_seed_id": frame_record["seed_id"],
            "frame_hex_length": len(frame_record["frame_hex"]),
            "started_at": started_at,
            "finished_at": utc_now(),
            "sanitizer_findings": sanitizer_findings,
        }
        if anomalous:
            if len(sanitizer_findings) > 0:
                summary["error"] = (
                    "Sanitizer instrumentation reported findings after the crafted "
                    "frame was delivered; PX4 may still be running. This is structural instrumentation "
                    "evidence, not a crash-exit verdict."
                )
            else:
                summary["error"] = (
                    "PX4 exited or logged abnormal markers after the crafted frame was delivered."
                )
        summary["frame_delivered"] = True
        print(json.dumps(summary))
        return 0
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc()
        write_text(runtime_log, truncate_log(f"{tb}\n"))
        print(json.dumps({"status": "harness_failed", "error": str(exc), "traceback": tb}))
        return 2
    finally:
        if proc is not None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except Exception:
                    proc.kill()
                proc.wait(timeout=3)
            except Exception:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
        if runtime_log.exists():
            shrink_runtime_log(runtime_log)


if __name__ == "__main__":
    raise SystemExit(main())
