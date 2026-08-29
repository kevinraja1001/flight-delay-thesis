#!/usr/bin/env python3
"""Merge monthly domestic-flight partitions into slim CSV and CSV.GZ files."""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import re
import sqlite3
import sys
import tempfile
from pathlib import Path


FIELDS = [
    "dataset_key",
    "ident_icao",
    "ident_iata",
    "operator_icao",
    "operator_iata",
    "flight_number",
    "codeshares",
    "codeshares_iata",
    "blocked",
    "diverted",
    "cancelled",
    "origin_code_icao",
    "origin_code_iata",
    "origin_timezone",
    "origin_name",
    "origin_city",
    "destination_code_icao",
    "destination_code_iata",
    "destination_timezone",
    "destination_name",
    "destination_city",
    "departure_delay",
    "arrival_delay",
    "scheduled_out",
    "scheduled_out_local",
    "actual_out",
    "actual_out_local",
    "scheduled_off",
    "scheduled_off_local",
    "actual_off",
    "actual_off_local",
    "scheduled_on",
    "scheduled_on_local",
    "actual_on",
    "actual_on_local",
    "scheduled_in",
    "scheduled_in_local",
    "actual_in",
    "actual_in_local",
    "status",
    "aircraft_type",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Merge YYYYMM.csv files from a monthly domestic dataset, retaining "
            "only the configured analysis fields."
        )
    )
    parser.add_argument(
        "input_dir",
        nargs="?",
        type=Path,
        default=Path("datasets/domestic_monthly"),
        help="monthly CSV directory (default: datasets/domestic_monthly)",
    )
    parser.add_argument(
        "-o",
        "--csv-output",
        type=Path,
        default=Path("datasets/domestic_flights.csv"),
        help="plain CSV output (default: datasets/domestic_flights.csv)",
    )
    parser.add_argument(
        "-z",
        "--gzip-output",
        type=Path,
        help="compressed output (default: CSV_OUTPUT.gz)",
    )
    parser.add_argument(
        "--delimiter",
        default=";",
        help="CSV delimiter (default: semicolon)",
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
        "--compresslevel",
        type=int,
        choices=range(1, 10),
        default=9,
        metavar="1-9",
        help="Gzip compression level (default: 9)",
    )
    return parser.parse_args()


def monthly_files(input_dir: Path) -> list[Path]:
    pattern = re.compile(r"^\d{6}\.csv$")
    files = sorted(
        path for path in input_dir.iterdir() if path.is_file() and pattern.fullmatch(path.name)
    )
    if not files:
        raise ValueError(f"{input_dir}: no YYYYMM.csv files found")
    return files


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


class MergeIndex:
    def __init__(self, directory: Path) -> None:
        descriptor, database_name = tempfile.mkstemp(
            prefix=".domestic-merge.", suffix=".sqlite3", dir=directory
        )
        os.close(descriptor)
        self.path = Path(database_name)
        self.connection = sqlite3.connect(self.path)
        self.connection.execute("PRAGMA journal_mode=OFF")
        self.connection.execute("PRAGMA synchronous=OFF")
        self.connection.execute(
            """
            CREATE TABLE records (
                dataset_key TEXT PRIMARY KEY,
                populated INTEGER NOT NULL,
                sequence INTEGER NOT NULL,
                row_json TEXT NOT NULL
            )
            """
        )
        self.sequence = 0

    def add(self, row: dict[str, str]) -> None:
        key = row["dataset_key"].strip()
        if not key:
            raise ValueError("dataset_key is empty")
        self.sequence += 1
        populated = sum(bool(row[field].strip()) for field in FIELDS)
        self.connection.execute(
            """
            INSERT INTO records VALUES (?, ?, ?, ?)
            ON CONFLICT(dataset_key) DO UPDATE SET
                populated=excluded.populated,
                sequence=excluded.sequence,
                row_json=excluded.row_json
            WHERE (excluded.populated, excluded.sequence)
                > (records.populated, records.sequence)
            """,
            (
                key,
                populated,
                self.sequence,
                json.dumps(row, ensure_ascii=False, separators=(",", ":")),
            ),
        )

    def count(self) -> int:
        return int(self.connection.execute("SELECT COUNT(*) FROM records").fetchone()[0])

    def rows(self):
        cursor = self.connection.execute(
            "SELECT row_json FROM records ORDER BY dataset_key"
        )
        for (row_json,) in cursor:
            yield json.loads(row_json)

    def close(self) -> None:
        self.connection.close()
        self.path.unlink(missing_ok=True)


def load_partitions(
    files: list[Path], delimiter: str, index: MergeIndex, allowed_operators: set[str]
) -> tuple[int, int, int]:
    input_rows = 0
    rejected_rows = 0
    missing_columns_seen: set[str] = set()
    for path in files:
        with path.open("r", encoding="utf-8-sig", newline="") as source:
            reader = csv.DictReader(source, delimiter=delimiter)
            if not reader.fieldnames or "dataset_key" not in reader.fieldnames:
                raise ValueError(f"{path}: dataset_key column is missing")
            missing_columns_seen.update(set(FIELDS) - set(reader.fieldnames))
            for line_number, source_row in enumerate(reader, start=2):
                if None in source_row:
                    raise ValueError(f"{path}:{line_number}: row has too many fields")
                if source_row.get("operator_icao", "").strip().upper() not in allowed_operators:
                    rejected_rows += 1
                    continue
                row = {field: source_row.get(field, "") or "" for field in FIELDS}
                try:
                    index.add(row)
                except ValueError as error:
                    raise ValueError(f"{path}:{line_number}: {error}") from error
                input_rows += 1
    return input_rows, rejected_rows, len(missing_columns_seen)


def temporary_path(output: Path) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".tmp", dir=output.parent
    )
    os.close(descriptor)
    return Path(name)


def write_outputs(
    csv_output: Path,
    gzip_output: Path,
    delimiter: str,
    compresslevel: int,
    index: MergeIndex,
) -> None:
    csv_temporary = temporary_path(csv_output)
    gzip_temporary = temporary_path(gzip_output)
    try:
        with csv_temporary.open("w", encoding="utf-8", newline="") as plain, gzip.open(
            gzip_temporary,
            "wt",
            encoding="utf-8",
            newline="",
            compresslevel=compresslevel,
        ) as compressed:
            plain_writer = csv.DictWriter(
                plain, fieldnames=FIELDS, delimiter=delimiter, lineterminator="\n"
            )
            gzip_writer = csv.DictWriter(
                compressed, fieldnames=FIELDS, delimiter=delimiter, lineterminator="\n"
            )
            plain_writer.writeheader()
            gzip_writer.writeheader()
            for row in index.rows():
                plain_writer.writerow(row)
                gzip_writer.writerow(row)

        os.chmod(csv_temporary, 0o664)
        os.chmod(gzip_temporary, 0o664)
        os.replace(csv_temporary, csv_output)
        os.replace(gzip_temporary, gzip_output)
    except BaseException:
        csv_temporary.unlink(missing_ok=True)
        gzip_temporary.unlink(missing_ok=True)
        raise


def main() -> int:
    args = parse_args()
    if len(args.delimiter) != 1:
        print("error: --delimiter must be one character", file=sys.stderr)
        return 2
    gzip_output = args.gzip_output or Path(str(args.csv_output) + ".gz")
    if args.csv_output.resolve() == gzip_output.resolve():
        print("error: CSV and Gzip outputs must be different files", file=sys.stderr)
        return 2

    index: MergeIndex | None = None
    try:
        if not args.input_dir.is_dir():
            raise ValueError(f"{args.input_dir}: input directory does not exist")
        if not args.airlines.is_file():
            raise ValueError(f"{args.airlines}: airline CSV does not exist")
        allowed_operators = load_allowed_operators(args.airlines)
        files = monthly_files(args.input_dir)
        args.csv_output.parent.mkdir(parents=True, exist_ok=True)
        gzip_output.parent.mkdir(parents=True, exist_ok=True)
        index = MergeIndex(args.csv_output.parent)
        input_rows, rejected_rows, missing_column_count = load_partitions(
            files, args.delimiter, index, allowed_operators
        )
        index.connection.commit()
        unique_rows = index.count()
        write_outputs(
            args.csv_output,
            gzip_output,
            args.delimiter,
            args.compresslevel,
            index,
        )
        print(f"Monthly files merged: {len(files)}")
        print(f"Input records: {input_rows}")
        print(f"Records rejected by operator ICAO: {rejected_rows}")
        print(f"Unique output records: {unique_rows}")
        print(f"Duplicate records removed: {input_rows - unique_rows}")
        print(f"Selected fields: {len(FIELDS)}")
        if missing_column_count:
            print(
                f"Fields absent from at least one source header and filled blank: "
                f"{missing_column_count}"
            )
        print(f"CSV: {args.csv_output}")
        print(f"CSV.GZ: {gzip_output}")
        return 0
    except (OSError, ValueError, csv.Error, sqlite3.Error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    finally:
        if index is not None:
            index.close()


if __name__ == "__main__":
    raise SystemExit(main())
