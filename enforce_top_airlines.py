#!/usr/bin/env python3
"""Remove disallowed operators from monthly domestic-flight partitions."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import tempfile
from pathlib import Path

from build_domestic_dataset import atomic_json_write, file_signature, utc_now


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Atomically filter YYYYMM.csv partitions by an allowed ICAO list."
    )
    parser.add_argument(
        "input_dir",
        nargs="?",
        type=Path,
        default=Path("datasets/domestic_monthly"),
        help="monthly dataset directory (default: datasets/domestic_monthly)",
    )
    parser.add_argument(
        "--airlines",
        type=Path,
        default=Path("datasets/top-australian-airlines.csv"),
        help="airline CSV containing ICAO",
    )
    parser.add_argument("--delimiter", default=";", help="CSV delimiter")
    return parser.parse_args()


def allowed_operators(path: Path) -> set[str]:
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        if not reader.fieldnames or "ICAO" not in reader.fieldnames:
            raise ValueError(f"{path}: ICAO column is missing")
        values = {
            row["ICAO"].strip().upper() for row in reader if row["ICAO"].strip()
        }
    if not values:
        raise ValueError(f"{path}: no ICAO values found")
    return values


def filter_partition(
    path: Path, delimiter: str, allowed: set[str]
) -> tuple[int, int]:
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source, delimiter=delimiter)
        if not reader.fieldnames or "operator_icao" not in reader.fieldnames:
            raise ValueError(f"{path}: operator_icao column is missing")
        fieldnames = reader.fieldnames
        kept: list[dict[str, str]] = []
        removed = 0
        for line_number, row in enumerate(reader, start=2):
            if None in row:
                raise ValueError(f"{path}:{line_number}: row has too many fields")
            if row.get("operator_icao", "").strip().upper() in allowed:
                kept.append(row)
            else:
                removed += 1

    if removed:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as target:
                writer = csv.DictWriter(
                    target,
                    fieldnames=fieldnames,
                    delimiter=delimiter,
                    extrasaction="raise",
                    lineterminator="\n",
                )
                writer.writeheader()
                writer.writerows(kept)
            os.chmod(temporary, 0o664)
            os.replace(temporary, path)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    return len(kept), removed


def update_manifest(
    path: Path,
    input_dir: Path,
    airlines: Path,
    counts: dict[str, int],
) -> None:
    if path.exists():
        with path.open("r", encoding="utf-8") as source:
            manifest = json.load(source)
    else:
        manifest = {"version": 2, "processed_files": {}, "monthly_files": {}}
    if manifest.get("version") != 2:
        raise ValueError(f"{path}: unsupported manifest format")
    monthly_files = manifest.setdefault("monthly_files", {})
    for month, count in counts.items():
        monthly_path = input_dir / f"{month}.csv"
        details = monthly_files.setdefault(month, {})
        details.update({"path": str(monthly_path.resolve()), "records": count})
    manifest.update(
        {
            "output_directory": str(input_dir.resolve()),
            "airlines_file": file_signature(airlines),
            "updated_at": utc_now(),
            "dataset_records": sum(counts.values()),
        }
    )
    atomic_json_write(path, manifest)


def main() -> int:
    args = parse_args()
    if len(args.delimiter) != 1:
        print("error: --delimiter must be one character", file=sys.stderr)
        return 2
    try:
        if not args.input_dir.is_dir():
            raise ValueError(f"{args.input_dir}: directory does not exist")
        if not args.airlines.is_file():
            raise ValueError(f"{args.airlines}: file does not exist")
        allowed = allowed_operators(args.airlines)
        paths = sorted(
            path
            for path in args.input_dir.iterdir()
            if path.is_file() and re.fullmatch(r"\d{6}\.csv", path.name)
        )
        if not paths:
            raise ValueError(f"{args.input_dir}: no YYYYMM.csv files found")

        counts: dict[str, int] = {}
        total_removed = 0
        changed = 0
        for path in paths:
            kept, removed = filter_partition(path, args.delimiter, allowed)
            counts[path.stem] = kept
            total_removed += removed
            changed += bool(removed)
            if removed:
                print(f"{path.name}: removed {removed}, retained {kept}")

        update_manifest(
            args.input_dir / "manifest.json",
            args.input_dir,
            args.airlines,
            counts,
        )
        print(f"Allowed ICAOs: {', '.join(sorted(allowed))}")
        print(f"Monthly files checked: {len(paths)}")
        print(f"Monthly files changed: {changed}")
        print(f"Records removed: {total_removed}")
        print(f"Records retained: {sum(counts.values())}")
        return 0
    except (OSError, ValueError, csv.Error, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
