#!/usr/bin/env python3
"""Combine semicolon-delimited CSV files, and append new ones to an existing combined file.

Usage:
    python combine_csv.py create [files...] [-o combined.csv]
    python combine_csv.py append [files...] [-o combined.csv]

With no file arguments, both commands default to all "20*.csv" files in the
current directory. "append" automatically skips files already merged into
the output, tracked in a small manifest file next to it
(<output>.manifest.json), so re-running it with the default glob only picks
up files that are actually new.
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Combine CSV files by header name, or append new ones to an existing combined file."
    )
    parser.add_argument(
        "mode",
        choices=["create", "append"],
        help="'create' builds a new combined file; 'append' adds new files to an existing one",
    )
    parser.add_argument(
        "inputs",
        nargs="*",
        type=Path,
        help="input CSV files (default: all 20*.csv files in the current directory)",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("combined.csv"),
        help="combined output path (default: combined.csv)",
    )
    parser.add_argument(
        "--delimiter",
        default=";",
        help="CSV delimiter (default: semicolon)",
    )
    return parser.parse_args()


def default_inputs() -> list[Path]:
    return [Path(name) for name in sorted(glob.glob("20*.csv"))]


def manifest_path(output: Path) -> Path:
    return output.with_name(output.name + ".manifest.json")


def read_manifest(output: Path) -> set[str]:
    path = manifest_path(output)
    if not path.exists():
        return set()
    return set(json.loads(path.read_text(encoding="utf-8")))


def write_manifest(output: Path, names: set[str]) -> None:
    manifest_path(output).write_text(
        json.dumps(sorted(names), indent=2) + "\n", encoding="utf-8"
    )


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


def iter_rows(path: Path, header: list[str], delimiter: str):
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source, delimiter=delimiter)
        if reader.fieldnames != header:
            raise ValueError(f"{path}: header changed while reading")
        for line_number, row in enumerate(reader, start=2):
            if None in row:
                raise ValueError(
                    f"{path}:{line_number}: row has more fields than its header"
                )
            yield row


def merge_columns(headers: dict[Path, list[str]], base: list[str] | None = None) -> list[str]:
    columns = list(base or [])
    seen = set(columns)
    for header in headers.values():
        for column in header:
            if column not in seen:
                seen.add(column)
                columns.append(column)
    return columns


def select_inputs(inputs: list[Path], output: Path) -> list[Path]:
    resolved_output = output.resolve()
    selected = [path for path in inputs if path.resolve() != resolved_output]
    if not selected:
        raise ValueError("no input CSV files were found")
    return selected


def create(inputs: list[Path], output: Path, delimiter: str) -> tuple[int, int]:
    selected = select_inputs(inputs, output)
    headers = {path: read_header(path, delimiter) for path in selected}
    columns = merge_columns(headers)

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
            for row in iter_rows(path, headers[path], delimiter):
                writer.writerow(row)
                row_count += 1

    write_manifest(output, {path.name for path in selected})
    return len(selected), row_count


def rewrite_with_columns(output: Path, columns: list[str], delimiter: str) -> None:
    tmp = output.with_name(output.name + ".tmp")
    with output.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source, delimiter=delimiter)
        with tmp.open("w", encoding="utf-8", newline="") as destination:
            writer = csv.DictWriter(
                destination,
                fieldnames=columns,
                delimiter=delimiter,
                extrasaction="raise",
                lineterminator="\n",
            )
            writer.writeheader()
            for row in reader:
                writer.writerow(row)
    tmp.replace(output)


def append(inputs: list[Path], output: Path, delimiter: str) -> tuple[int, int]:
    if not output.exists():
        raise ValueError(f"{output} does not exist; run 'create' first")

    already_merged = read_manifest(output)
    candidates = select_inputs(inputs, output)
    selected = [path for path in candidates if path.name not in already_merged]
    skipped = [path for path in candidates if path.name in already_merged]
    for path in skipped:
        print(f"skipping {path} (already in {output})", file=sys.stderr)
    if not selected:
        raise ValueError("no new input CSV files to append")

    existing_columns = read_header(output, delimiter)
    headers = {path: read_header(path, delimiter) for path in selected}
    columns = merge_columns(headers, base=existing_columns)

    if columns != existing_columns:
        rewrite_with_columns(output, columns, delimiter)
        existing_columns = columns

    row_count = 0
    with output.open("a", encoding="utf-8", newline="") as destination:
        writer = csv.DictWriter(
            destination,
            fieldnames=existing_columns,
            delimiter=delimiter,
            extrasaction="raise",
            lineterminator="\n",
        )
        for path in selected:
            for row in iter_rows(path, headers[path], delimiter):
                writer.writerow(row)
                row_count += 1

    write_manifest(output, already_merged | {path.name for path in selected})
    return len(selected), row_count


def main() -> int:
    args = parse_args()
    if len(args.delimiter) != 1:
        print("error: --delimiter must be one character", file=sys.stderr)
        return 2

    inputs = args.inputs or default_inputs()
    action = create if args.mode == "create" else append
    try:
        file_count, row_count = action(inputs, args.output, args.delimiter)
    except (OSError, ValueError, csv.Error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    verb = "Combined" if args.mode == "create" else "Appended"
    print(f"{verb} {file_count} files and {row_count} rows -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
