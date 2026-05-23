#!/usr/bin/env python3
"""MAVLink parser-library fuzz harness using pymavlink.

Writes artifacts to the supplied artifact directory and prints a one-line JSON
summary to stdout for the TypeScript runner to consume.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from pymavlink.dialects.v20 import common as dialect
    import pymavlink
except ImportError as exc:
    print(json.dumps({"status": "setup_failed", "error": f"pymavlink import failed: {exc}"}))
    sys.exit(3)


CAVEATS = [
    "This is parser-library evidence using pymavlink.",
    "This is not PX4 SITL evidence.",
    "This does not prove PX4 MavlinkReceiver runtime behavior.",
]


@dataclass
class ParseOutcome:
    input_id: int
    seed_id: int
    strategy: str
    outcome: str
    message_type: str
    detail: str
    hex_preview: str


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_nominal_battery_status(mav: dialect.MAVLink) -> bytes:
    voltages = [11000, 11000, 11000] + [0] * 7
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
    return msg.pack(mav)


def build_zero_cell_battery_status(mav: dialect.MAVLink) -> bytes:
    msg = dialect.MAVLink_battery_status_message(
        id=1,
        battery_function=dialect.MAV_BATTERY_FUNCTION_ALL,
        type=dialect.MAV_BATTERY_TYPE_LION,
        temperature=0,
        voltages=[0] * 10,
        current_battery=0,
        current_consumed=0,
        energy_consumed=0,
        battery_remaining=0,
        time_remaining=0,
        charge_state=dialect.MAV_BATTERY_CHARGE_STATE_UNDEFINED,
        voltages_ext=[0, 0, 0, 0],
        mode=dialect.MAV_BATTERY_MODE_UNKNOWN,
        fault_bitmask=0,
    )
    return msg.pack(mav)


def hex_preview(data: bytes, limit: int = 32) -> str:
    snippet = data[:limit].hex()
    if len(data) > limit:
        return f"{snippet}..."
    return snippet


def flip_byte(data: bytearray, rng: random.Random) -> None:
    if not data:
        return
    index = rng.randrange(len(data))
    data[index] ^= 1 << rng.randrange(8)


def truncate_frame(data: bytearray, rng: random.Random) -> None:
    if len(data) <= 8:
        return
    new_len = rng.randrange(8, len(data))
    del data[new_len:]


def corrupt_length_or_checksum(data: bytearray, rng: random.Random) -> None:
    if len(data) < 12:
        return
    target = rng.choice(["length", "checksum"])
    if target == "length" and len(data) > 1:
        data[1] = rng.randrange(256)
    else:
        index = rng.randrange(max(len(data) - 2, 1), len(data))
        data[index] = rng.randrange(256)


def extend_payload(data: bytearray, rng: random.Random) -> None:
    extra = bytes(rng.randrange(0, 256) for _ in range(rng.randrange(1, 9)))
    data.extend(extra)


MUTATORS = {
    "byte_flip": flip_byte,
    "truncation": truncate_frame,
    "length_checksum_corruption": corrupt_length_or_checksum,
    "payload_extension": extend_payload,
}


def parse_frame(frame: bytes) -> tuple[str, str, str]:
    mav = dialect.MAVLink(None, srcSystem=1, srcComponent=1)
    parsed_types: list[str] = []
    try:
        for byte in frame:
            msg = mav.parse_char(bytes([byte]))
            if msg is not None:
                parsed_types.append(msg.get_type())
        if parsed_types:
            return "parsed", parsed_types[-1], f"parsed {len(parsed_types)} message(s)"
        return "clean_rejection", "", "no complete message decoded"
    except Exception as exc:
        return "parser_exception", "", f"{type(exc).__name__}: {exc}"


def mutate_seed(seed: bytes, strategy: str, rng: random.Random) -> bytes:
    data = bytearray(seed)
    mutator = MUTATORS[strategy]
    mutator(data, rng)
    return bytes(data)


def write_failure_md(path: Path, stage: str, detail: str) -> None:
    path.write_text(
        "\n".join(
            [
                "# MAVLink Parser Fuzz Setup Failure",
                "",
                f"Stage: {stage}",
                f"Detail: {detail}",
                "",
                "The parser fuzz runner did not execute a parser budget because setup failed.",
                "",
                *CAVEATS,
                "",
            ]
        ),
        encoding="utf-8",
    )


def run_harness(args: argparse.Namespace) -> dict[str, Any]:
    artifact_dir = Path(args.artifact_dir)
    artifact_dir.mkdir(parents=True, exist_ok=True)
    log_path = artifact_dir / "runner.log"
    log_lines: list[str] = []

    def log(message: str) -> None:
        line = f"[{utc_now()}] {message}"
        log_lines.append(line)

    rng = random.Random(args.seed)
    strategies = [item.strip() for item in args.strategies.split(",") if item.strip()]
    budget = args.mutation_budget
    seed_descriptions = json.loads(args.seed_descriptions_json)

    log(f"Starting pymavlink parser fuzz; budget={budget}; dialect={args.dialect}")

    mav = dialect.MAVLink(None, srcSystem=1, srcComponent=1)
    seed_builders = [build_nominal_battery_status, build_zero_cell_battery_status]
    seeds: list[dict[str, Any]] = []
    for index, builder in enumerate(seed_builders[: len(seed_descriptions)]):
        frame = builder(mav)
        seeds.append(
            {
                "seed_id": index,
                "description": seed_descriptions[index],
                "message_family": args.message_family,
                "hex": frame.hex(),
                "length_bytes": len(frame),
            }
        )

    (artifact_dir / "seed-corpus.json").write_text(json.dumps({"seeds": seeds}, indent=2), encoding="utf-8")
    log(f"Wrote {len(seeds)} seed frame(s) to seed-corpus.json")

    outcomes: list[ParseOutcome] = []
    failure_input: bytes | None = None
    failure_strategy = ""
    exceptions = 0
    input_id = 0

    for seed in seeds:
        seed_bytes = bytes.fromhex(seed["hex"])
        for strategy in strategies:
            remaining = budget - len(outcomes)
            if remaining <= 0:
                break
            per_strategy = max(1, remaining // max(len(strategies) * len(seeds), 1))
            for _ in range(per_strategy):
                if len(outcomes) >= budget:
                    break
                mutated = mutate_seed(seed_bytes, strategy, rng)
                outcome_kind, message_type, detail = parse_frame(mutated)
                outcomes.append(
                    ParseOutcome(
                        input_id=input_id,
                        seed_id=seed["seed_id"],
                        strategy=strategy,
                        outcome=outcome_kind,
                        message_type=message_type,
                        detail=detail,
                        hex_preview=hex_preview(mutated),
                    )
                )
                if outcome_kind == "parser_exception":
                    exceptions += 1
                    if failure_input is None:
                        failure_input = mutated
                        failure_strategy = strategy
                input_id += 1
            if len(outcomes) >= budget:
                break
        if len(outcomes) >= budget:
            break

    while len(outcomes) < budget:
        seed = seeds[rng.randrange(len(seeds))]
        strategy = rng.choice(strategies)
        seed_bytes = bytes.fromhex(seed["hex"])
        mutated = mutate_seed(seed_bytes, strategy, rng)
        outcome_kind, message_type, detail = parse_frame(mutated)
        outcomes.append(
            ParseOutcome(
                input_id=input_id,
                seed_id=seed["seed_id"],
                strategy=strategy,
                outcome=outcome_kind,
                message_type=message_type,
                detail=detail,
                hex_preview=hex_preview(mutated),
            )
        )
        if outcome_kind == "parser_exception":
            exceptions += 1
            if failure_input is None:
                failure_input = mutated
                failure_strategy = strategy
        input_id += 1

    csv_path = artifact_dir / "parser-outcomes.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["input_id", "seed_id", "strategy", "outcome", "message_type", "detail", "hex_preview"])
        for row in outcomes:
            writer.writerow(
                [row.input_id, row.seed_id, row.strategy, row.outcome, row.message_type, row.detail, row.hex_preview]
            )

    manifest = {
        "pymavlink_version": pymavlink.__version__,
        "python_version": sys.version.split()[0],
        "dialect": args.dialect,
        "message_family": args.message_family,
        "mutation_budget": budget,
        "inputs_tried": len(outcomes),
        "mutation_strategies": strategies,
        "seed_count": len(seeds),
        "random_seed": args.seed,
        "completed_at": utc_now(),
    }
    (artifact_dir / "parser-run-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    verdict = "attention_required" if exceptions > 0 else "no_issue_detected"
    summary_lines = [
        "# MAVLink Parser Fuzz Evidence Summary",
        "",
        f"Message family: {args.message_family}",
        f"Dialect: {args.dialect}",
        f"Parser library: pymavlink {pymavlink.__version__}",
        f"Python: {sys.version.split()[0]}",
        f"Mutation budget: {budget}",
        f"Inputs tried: {len(outcomes)}",
        f"Parser exceptions observed: {exceptions}",
        f"Verdict: {verdict}",
        "",
        "This run mutates real MAVLink v2 BATTERY_STATUS seed frames and feeds them into the pymavlink decoder.",
        "",
        *CAVEATS,
        "",
    ]
    (artifact_dir / "evidence-summary.md").write_text("\n".join(summary_lines), encoding="utf-8")

    if failure_input is not None:
        (artifact_dir / "failure-input.bin").write_bytes(failure_input)
        (artifact_dir / "failure-input.hex").write_text(failure_input.hex() + "\n", encoding="utf-8")
        log(f"Recorded failure input from strategy={failure_strategy}")

    log(f"Completed parser fuzz with verdict={verdict}; exceptions={exceptions}")
    log_path.write_text("\n".join(log_lines) + "\n", encoding="utf-8")

    return {
        "status": "completed",
        "verdict": verdict,
        "pymavlink_version": pymavlink.__version__,
        "python_version": sys.version.split()[0],
        "dialect": args.dialect,
        "message_family": args.message_family,
        "mutation_budget": budget,
        "inputs_tried": len(outcomes),
        "exceptions_found": exceptions,
        "mutation_strategies": strategies,
        "failure_input_saved": failure_input is not None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="MAVLink parser-library fuzz harness")
    parser.add_argument("--artifact-dir", required=True)
    parser.add_argument("--mutation-budget", type=int, required=True)
    parser.add_argument("--dialect", default="common")
    parser.add_argument("--message-family", default="BATTERY_STATUS")
    parser.add_argument("--strategies", default="byte_flip,truncation,length_checksum_corruption,payload_extension")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--seed-descriptions-json", required=True)
    args = parser.parse_args()

    try:
        result = run_harness(args)
        print(json.dumps(result))
        sys.exit(0)
    except Exception as exc:
        artifact_dir = Path(args.artifact_dir)
        artifact_dir.mkdir(parents=True, exist_ok=True)
        write_failure_md(artifact_dir, "harness_execution", f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")
        (artifact_dir / "runner.log").write_text(f"harness crash: {exc}\n", encoding="utf-8")
        print(json.dumps({"status": "harness_failed", "error": str(exc)}))
        sys.exit(2)


if __name__ == "__main__":
    main()
