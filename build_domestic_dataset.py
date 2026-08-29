#!/usr/bin/env python3
"""Incrementally build monthly deduplicated Australian domestic-flight CSVs."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


CSV_COLUMN_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")
TIME_KINDS = ("scheduled", "estimated", "actual")
TIME_EVENTS = ("out", "off", "on", "in")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Extract CSV/JSON flight records from logs, reconstruct missing local "
            "timestamps, retain Australian domestic flights, and incrementally "
            "maintain deduplicated YYYYMM.csv files plus a processed-log manifest."
        )
    )
    parser.add_argument("logs", nargs="+", type=Path, help="log files to import")
    parser.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        default=Path("domestic_dataset"),
        help="directory for monthly CSVs and manifest (default: domestic_dataset)",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        help="manifest JSON (default: OUTPUT_DIR/manifest.json)",
    )
    parser.add_argument(
        "--airports",
        type=Path,
        default=Path("datasets/airports.csv"),
        help="airport CSV (default: datasets/airports.csv)",
    )
    parser.add_argument(
        "--airlines",
        type=Path,
        default=Path("datasets/top-australian-airlines.csv"),
        help=(
            "allowed-airline CSV containing ICAO (default: "
            "datasets/top-australian-airlines.csv)"
        ),
    )
    parser.add_argument(
        "--delimiter",
        default=";",
        help="flight CSV delimiter (default: semicolon)",
    )
    parser.add_argument(
        "--reprocess",
        action="store_true",
        help="process supplied logs even when unchanged entries exist in the manifest",
    )
    return parser.parse_args()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def file_signature(path: Path) -> dict[str, int | str]:
    stat = path.stat()
    return {
        "path": str(path.resolve()),
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
    }


def atomic_json_write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as target:
            json.dump(value, target, ensure_ascii=False, indent=2, sort_keys=True)
            target.write("\n")
        os.chmod(temporary, 0o664)
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def load_manifest(path: Path) -> dict[str, object]:
    if not path.exists():
        return {"version": 2, "processed_files": {}, "monthly_files": {}}
    with path.open("r", encoding="utf-8") as source:
        value = json.load(source)
    if not isinstance(value, dict) or value.get("version") != 2:
        raise ValueError(f"{path}: unsupported manifest format")
    if not isinstance(value.get("processed_files"), dict):
        raise ValueError(f"{path}: processed_files must be an object")
    if not isinstance(value.get("monthly_files"), dict):
        raise ValueError(f"{path}: monthly_files must be an object")
    return value


def load_australian_airports(path: Path) -> set[str]:
    airports: set[str] = set()
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        required = {"iso_country", "icao_code"}
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            raise ValueError(
                f"{path}: airport CSV must contain iso_country and icao_code"
            )
        for row in reader:
            if row["iso_country"].strip().upper() == "AU":
                code = row["icao_code"].strip().upper()
                if code:
                    airports.add(code)
    if not airports:
        raise ValueError(f"{path}: no Australian ICAO airport codes found")
    return airports


def load_allowed_operators(path: Path) -> set[str]:
    operators: set[str] = set()
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        if not reader.fieldnames or "ICAO" not in reader.fieldnames:
            raise ValueError(f"{path}: airline CSV must contain ICAO")
        for row in reader:
            operator = row["ICAO"].strip().upper()
            if operator:
                operators.add(operator)
    if not operators:
        raise ValueError(f"{path}: no allowed ICAO operators found")
    return operators


def flatten_object(value: dict[str, object], prefix: str = "") -> dict[str, str]:
    flattened: dict[str, str] = {}
    for key, item in value.items():
        column = f"{prefix}_{key}" if prefix else key
        if isinstance(item, dict):
            for nested_key, nested_value in flatten_object(item, column).items():
                if nested_key in flattened:
                    raise ValueError(f"duplicate flattened column: {nested_key}")
                flattened[nested_key] = nested_value
        elif isinstance(item, list):
            flattened[column] = json.dumps(
                item, ensure_ascii=False, separators=(",", ":")
            )
        elif isinstance(item, bool):
            flattened[column] = "true" if item else "false"
        elif item is None:
            flattened[column] = ""
        else:
            flattened[column] = str(item)
    return flattened


def parse_standalone_json(line: str) -> object | None:
    candidates = [line.strip()]
    if line.startswith("[") and "] " in line:
        candidates.append(line.split("] ", 1)[1].strip())
    for candidate in candidates:
        if not candidate or candidate[0] not in "[{":
            continue
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, (dict, list)):
            return value
    return None


def rows_from_json(value: object, path: Path, line_number: int) -> Iterator[dict[str, str]]:
    if isinstance(value, dict):
        yield flatten_object(value)
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                raise ValueError(
                    f"{path}:{line_number}: JSON array item {index} is not an object"
                )
            yield flatten_object(item)


def is_csv_header(fields: list[str]) -> bool:
    cleaned = [field.strip().lstrip("\ufeff") for field in fields]
    return (
        len(cleaned) >= 2
        and len(cleaned) == len(set(cleaned))
        and all(CSV_COLUMN_NAME.fullmatch(field) for field in cleaned)
    )


def flight_rows(path: Path, delimiter: str) -> Iterator[dict[str, str]]:
    """Yield records from standalone JSON arrays/objects or embedded CSV blocks."""
    csv_header: list[str] | None = None
    with path.open("r", encoding="utf-8", errors="replace", newline="") as source:
        for line_number, raw_line in enumerate(source, start=1):
            line = raw_line.rstrip("\r\n")
            if not line.strip():
                continue

            value = parse_standalone_json(line)
            if value is not None:
                yield from rows_from_json(value, path, line_number)
                continue

            # Timestamped application messages are logs even if their message
            # happens to contain the configured delimiter.
            if re.match(r"^\[\d{4}-\d{2}-\d{2}T", line):
                continue

            if delimiter not in line:
                continue
            fields = next(csv.reader([line], delimiter=delimiter))
            if is_csv_header(fields):
                csv_header = [field.strip().lstrip("\ufeff") for field in fields]
                continue
            if csv_header is not None and len(fields) == len(csv_header):
                yield dict(zip(csv_header, fields))


def parse_datetime(value: str) -> datetime | None:
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def provide_local_timestamps(row: dict[str, str]) -> int:
    """Fill missing local timestamps; return the number of values supplied."""
    supplied = 0
    for event in TIME_EVENTS:
        timezone_field = "origin_timezone" if event in {"out", "off"} else "destination_timezone"
        timezone_name = row.get(timezone_field, "").strip()
        zone: ZoneInfo | None = None
        if timezone_name:
            try:
                zone = ZoneInfo(timezone_name)
            except ZoneInfoNotFoundError:
                zone = None

        for kind in TIME_KINDS:
            utc_field = f"{kind}_{event}"
            local_field = f"{utc_field}_local"
            if row.get(local_field, "").strip():
                continue
            row[local_field] = ""
            parsed = parse_datetime(row.get(utc_field, ""))
            if parsed is not None and zone is not None:
                row[local_field] = parsed.astimezone(zone).isoformat(timespec="seconds")
                supplied += 1
    return supplied


def is_domestic(row: dict[str, str], australian_airports: set[str]) -> bool:
    origin = row.get("origin_code_icao", "").strip().upper()
    destination = row.get("destination_code_icao", "").strip().upper()
    return origin in australian_airports and destination in australian_airports


def compact_date(value: str) -> str:
    parsed = parse_datetime(value)
    if parsed is not None:
        return parsed.strftime("%Y%m%d")
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", value.strip())
    return "".join(match.groups()) if match else ""


def record_key_and_month(row: dict[str, str]) -> tuple[str, str] | None:
    operator = row.get("operator_icao", "").strip()
    flight_number = row.get("flight_number", "").strip()
    origin = row.get("origin_code_iata", "").strip()
    destination = row.get("destination_code_iata", "").strip()
    date_value = next(
        (
            row.get(field, "").strip()
            for field in (
                "scheduled_out_local",
                "scheduled_off_local",
                "scheduled_out",
                "scheduled_off",
            )
            if row.get(field, "").strip()
        ),
        "",
    )
    date = compact_date(date_value)
    if not all((operator, flight_number, origin, destination, date)):
        return None
    key = f"{operator}{flight_number}_{origin}-{destination}_{date}"
    return key, date[:6]


def truthy(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes"}


def numeric_progress(value: str) -> int:
    try:
        return max(0, min(100, int(float(value))))
    except (TypeError, ValueError):
        return 0


def detail_score(row: dict[str, str]) -> tuple[int, int, int, int, int]:
    actual_count = sum(
        bool(row.get(f"actual_{event}", "").strip() or row.get(f"actual_{event}_local", "").strip())
        for event in TIME_EVENTS
    )
    estimated_count = sum(
        bool(
            row.get(f"estimated_{event}", "").strip()
            or row.get(f"estimated_{event}_local", "").strip()
        )
        for event in TIME_EVENTS
    )
    progress = numeric_progress(row.get("progress_percent", ""))
    terminal = int(
        truthy(row.get("cancelled", ""))
        or bool(row.get("actual_on", "").strip())
        or bool(row.get("actual_in", "").strip())
        or progress >= 100
    )
    populated = sum(bool(str(value).strip()) for value in row.values())
    return terminal, actual_count, populated, progress, estimated_count


class RecordIndex:
    def __init__(self, directory: Path) -> None:
        descriptor, database_name = tempfile.mkstemp(
            prefix=".domestic-records.", suffix=".sqlite3", dir=directory
        )
        os.close(descriptor)
        self.path = Path(database_name)
        self.connection = sqlite3.connect(self.path)
        self.connection.execute("PRAGMA journal_mode=OFF")
        self.connection.execute("PRAGMA synchronous=OFF")
        self.connection.execute(
            """
            CREATE TABLE records (
                record_key TEXT PRIMARY KEY,
                terminal INTEGER NOT NULL,
                actual_count INTEGER NOT NULL,
                populated INTEGER NOT NULL,
                progress INTEGER NOT NULL,
                estimated_count INTEGER NOT NULL,
                sequence INTEGER NOT NULL,
                row_json TEXT NOT NULL
            )
            """
        )
        self.columns = ["dataset_key"]
        self.seen_columns = {"dataset_key"}
        self.sequence = 0

    def add(self, key: str, row: dict[str, str]) -> None:
        self.sequence += 1
        row = dict(row)
        row["dataset_key"] = key
        for column in row:
            if column not in self.seen_columns:
                self.seen_columns.add(column)
                self.columns.append(column)
        terminal, actual, populated, progress, estimated = detail_score(row)
        self.connection.execute(
            """
            INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(record_key) DO UPDATE SET
                terminal=excluded.terminal,
                actual_count=excluded.actual_count,
                populated=excluded.populated,
                progress=excluded.progress,
                estimated_count=excluded.estimated_count,
                sequence=excluded.sequence,
                row_json=excluded.row_json
            WHERE (
                excluded.terminal,
                excluded.actual_count,
                excluded.populated,
                excluded.progress,
                excluded.estimated_count,
                excluded.sequence
            ) > (
                records.terminal,
                records.actual_count,
                records.populated,
                records.progress,
                records.estimated_count,
                records.sequence
            )
            """,
            (
                key,
                terminal,
                actual,
                populated,
                progress,
                estimated,
                self.sequence,
                json.dumps(row, ensure_ascii=False, separators=(",", ":")),
            ),
        )

    def count(self) -> int:
        return int(self.connection.execute("SELECT COUNT(*) FROM records").fetchone()[0])

    def rows(self) -> Iterator[dict[str, str]]:
        cursor = self.connection.execute(
            "SELECT row_json FROM records ORDER BY record_key"
        )
        for (row_json,) in cursor:
            yield json.loads(row_json)

    def close(self) -> None:
        self.connection.close()
        self.path.unlink(missing_ok=True)


def load_existing(path: Path, delimiter: str, index: RecordIndex) -> int:
    if not path.exists():
        return 0
    count = 0
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source, delimiter=delimiter)
        if not reader.fieldnames or "dataset_key" not in reader.fieldnames:
            raise ValueError(f"{path}: existing dataset has no dataset_key column")
        for line_number, row in enumerate(reader, start=2):
            if None in row:
                raise ValueError(f"{path}:{line_number}: row has too many fields")
            key = row.get("dataset_key", "").strip()
            if not key:
                raise ValueError(f"{path}:{line_number}: dataset_key is empty")
            index.add(key, row)
            count += 1
    return count


def atomic_csv_write(path: Path, delimiter: str, index: RecordIndex) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as target:
            writer = csv.DictWriter(
                target,
                fieldnames=index.columns,
                delimiter=delimiter,
                extrasaction="raise",
                lineterminator="\n",
            )
            writer.writeheader()
            writer.writerows(index.rows())
        os.chmod(temporary, 0o664)
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def main() -> int:
    args = parse_args()
    if len(args.delimiter) != 1:
        print("error: --delimiter must be one character", file=sys.stderr)
        return 2

    output_dir: Path = args.output_dir
    manifest_path = args.manifest or output_dir / "manifest.json"
    indexes: dict[str, RecordIndex] = {}
    try:
        if not args.airports.is_file():
            raise ValueError(f"{args.airports}: airport CSV does not exist")
        if not args.airlines.is_file():
            raise ValueError(f"{args.airlines}: airline CSV does not exist")
        for log in args.logs:
            if not log.is_file():
                raise ValueError(f"{log}: log file does not exist")

        manifest = load_manifest(manifest_path)
        monthly_files = manifest["monthly_files"]
        assert isinstance(monthly_files, dict)
        for month, details in monthly_files.items():
            monthly_path = output_dir / f"{month}.csv"
            if isinstance(details, dict) and details.get("records", 0) and not monthly_path.is_file():
                raise ValueError(
                    f"{monthly_path}: file recorded by the manifest is missing"
                )

        airport_signature = file_signature(args.airports)
        previous_airports = manifest.get("airports_file")
        if previous_airports and previous_airports != airport_signature:
            raise ValueError(
                "airport dataset changed; rebuild with a new output and manifest"
            )
        australian_airports = load_australian_airports(args.airports)
        airline_signature = file_signature(args.airlines)
        previous_airlines = manifest.get("airlines_file")
        if previous_airlines and previous_airlines != airline_signature:
            raise ValueError(
                "airline dataset changed; refilter the monthly dataset before importing"
            )
        allowed_operators = load_allowed_operators(args.airlines)

        processed_files = manifest["processed_files"]
        assert isinstance(processed_files, dict)
        selected: list[tuple[Path, dict[str, int | str]]] = []
        skipped = 0
        for log in args.logs:
            signature = file_signature(log)
            previous = processed_files.get(signature["path"])
            unchanged = (
                isinstance(previous, dict)
                and previous.get("size") == signature["size"]
                and previous.get("mtime_ns") == signature["mtime_ns"]
            )
            if unchanged and not args.reprocess:
                skipped += 1
            else:
                selected.append((log, signature))

        if not selected:
            print(f"No new or changed logs to process ({skipped} skipped).")
            return 0

        output_dir.mkdir(parents=True, exist_ok=True)
        existing_counts: dict[str, int] = {}

        def index_for_month(month: str) -> RecordIndex:
            if month not in indexes:
                monthly_path = output_dir / f"{month}.csv"
                month_index = RecordIndex(output_dir)
                existing_counts[month] = load_existing(
                    monthly_path, args.delimiter, month_index
                )
                indexes[month] = month_index
            return indexes[month]

        total_extracted = total_allowed = total_domestic = total_keyed = total_local = 0
        manifest_updates: dict[str, object] = {}
        for log, signature in selected:
            extracted = allowed = domestic = keyed = local_supplied = 0
            for row in flight_rows(log, args.delimiter):
                extracted += 1
                if row.get("operator_icao", "").strip().upper() not in allowed_operators:
                    continue
                allowed += 1
                if not is_domestic(row, australian_airports):
                    continue
                domestic += 1
                local_supplied += provide_local_timestamps(row)
                key_and_month = record_key_and_month(row)
                if key_and_month is None:
                    continue
                key, month = key_and_month
                keyed += 1
                index_for_month(month).add(key, row)
            manifest_updates[str(signature["path"])] = {
                **signature,
                "processed_at": utc_now(),
                "extracted_records": extracted,
                "allowed_operator_records": allowed,
                "domestic_records": domestic,
                "keyed_records": keyed,
                "local_timestamps_supplied": local_supplied,
            }
            total_extracted += extracted
            total_allowed += allowed
            total_domestic += domestic
            total_keyed += keyed
            total_local += local_supplied

        affected_months: dict[str, int] = {}
        for month, month_index in sorted(indexes.items()):
            month_index.connection.commit()
            monthly_path = output_dir / f"{month}.csv"
            atomic_csv_write(monthly_path, args.delimiter, month_index)
            record_count = month_index.count()
            affected_months[month] = record_count
            monthly_files[month] = {
                "path": str(monthly_path.resolve()),
                "records": record_count,
                "updated_at": utc_now(),
            }

        processed_files.update(manifest_updates)
        manifest.update(
            {
                "version": 2,
                "output_directory": str(output_dir.resolve()),
                "airports_file": airport_signature,
                "airlines_file": airline_signature,
                "updated_at": utc_now(),
                "dataset_records": sum(
                    int(details.get("records", 0))
                    for details in monthly_files.values()
                    if isinstance(details, dict)
                ),
                "monthly_files": monthly_files,
                "processed_files": processed_files,
            }
        )
        atomic_json_write(manifest_path, manifest)

        print(f"Logs processed: {len(selected)} ({skipped} unchanged skipped)")
        print(f"Records extracted: {total_extracted}")
        print(f"Records matching allowed airline ICAOs: {total_allowed}")
        print(f"Australian domestic records: {total_domestic}")
        print(f"Records with complete dataset keys: {total_keyed}")
        print(f"Missing local timestamps supplied: {total_local}")
        print(f"Monthly CSVs updated: {len(affected_months)}")
        for month, count in sorted(affected_months.items()):
            print(
                f"  {month}.csv: {count} unique records "
                f"({existing_counts.get(month, 0)} existing read)"
            )
        print(f"Dataset records across all months: {manifest['dataset_records']}")
        print(f"Output directory: {output_dir}")
        print(f"Manifest: {manifest_path}")
        return 0
    except (OSError, ValueError, csv.Error, json.JSONDecodeError, sqlite3.Error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    finally:
        for month_index in indexes.values():
            month_index.close()


if __name__ == "__main__":
    raise SystemExit(main())
