#!/usr/bin/env python3
"""Combine semicolon-delimited CSV files while aligning columns by header name."""

from __future__ import annotations

import argparse
import csv
import glob
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Combine CSV files into one file. Columns are matched by name, and "
            "missing values are left blank."
        )
    )
    parser.add_argument(
        "inputs",
        nargs="*",
        type=Path,
        help="input CSV files (default: all dated files matching 20*.csv)",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("combined.csv"),
        help="output path (default: combined.csv)",
    )
    parser.add_argument(
        "--delimiter",
        default=";",
        help="CSV delimiter (default: semicolon)",
    )
    return parser.parse_args()


def default_inputs() -> list[Path]:
    return [Path(name) for name in sorted(glob.glob("20*.csv"))]


def read_header(path: Path, delimiter: str) -> list[str]:
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, delimiter=delimiter)
        try:
            header = next(reader)
        except StopIteration as error:
            raise ValueError(f"{path}: file is empty") from error

    if not header or any(not column for column in header):
        raise ValueError(f"{path}: header contains an empty column name")
    if len(header) != len(set(header)):
        raise ValueError(f"{path}: header contains duplicate column names")
    return header


def combine(inputs: list[Path], output: Path, delimiter: str) -> tuple[int, int]:
    resolved_output = output.resolve()
    selected = [path for path in inputs if path.resolve() != resolved_output]
    if not selected:
        raise ValueError("no input CSV files were found")

    columns: list[str] = []
    seen_columns: set[str] = set()
    headers: dict[Path, list[str]] = {}

    for path in selected:
        header = read_header(path, delimiter)
        headers[path] = header
        for column in header:
            if column not in seen_columns:
                seen_columns.add(column)
                columns.append(column)

    output.parent.mkdir(parents=True, exist_ok=True)
    row_count = 0
    with output.open("w", encoding="utf-8", newline="") as destination:
        writer = csv.DictWriter(
            destination,
            fieldnames=columns,
            delimiter=delimiter,
            extrasaction="raise",
            lineterminator="\n",
        )
        writer.writeheader()

        for path in selected:
            with path.open("r", encoding="utf-8-sig", newline="") as source:
                reader = csv.DictReader(source, delimiter=delimiter)
                if reader.fieldnames != headers[path]:
                    raise ValueError(f"{path}: header changed while combining")
                for line_number, row in enumerate(reader, start=2):
                    if None in row:
                        raise ValueError(
                            f"{path}:{line_number}: row has more fields than its header"
                        )
                    writer.writerow(row)
                    row_count += 1

    return len(selected), row_count


def main() -> int:
    args = parse_args()
    if len(args.delimiter) != 1:
        print("error: --delimiter must be one character", file=sys.stderr)
        return 2

    inputs = args.inputs or default_inputs()
    try:
        file_count, row_count = combine(inputs, args.output, args.delimiter)
    except (OSError, ValueError, csv.Error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    print(f"Combined {file_count} files and {row_count} rows -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
