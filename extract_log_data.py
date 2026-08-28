#!/usr/bin/env python3
"""Extract CSV records or flattened JSON objects from a mixed log."""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Remove application log messages from a mixed log and extract its "
            "data into one CSV. JSON objects inside top-level arrays become rows, "
            "and nested objects are flattened with underscore-separated keys."
        )
    )
    parser.add_argument("input", type=Path, help="mixed log file")
    parser.add_argument(
        "-o",
        "--csv-output",
        type=Path,
        help="CSV output path (default: input name with .csv suffix)",
    )
    parser.add_argument(
        "-j",
        "--json-output",
        type=Path,
        help="optionally also save the extracted source arrays/objects as JSONL",
    )
    parser.add_argument(
        "--delimiter",
        default=";",
        help="CSV delimiter (default: semicolon)",
    )
    return parser.parse_args()


def json_value(line: str) -> object | None:
    """Return a standalone JSON object/array, or None for an ordinary log line."""
    candidates = [line.strip()]

    # Also support JSON payloads following a conventional "[metadata] " prefix.
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


def flatten_object(
    value: dict[str, object],
    prefix: str = "",
) -> dict[str, object]:
    """Flatten nested dictionaries; preserve arrays as compact JSON cell values."""
    flattened: dict[str, object] = {}

    for key, item in value.items():
        column = f"{prefix}_{key}" if prefix else key
        if isinstance(item, dict):
            nested = flatten_object(item, column)
            for nested_key, nested_value in nested.items():
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
            flattened[column] = item

    return flattened


def json_rows(value: object, line_number: int) -> list[dict[str, object]]:
    """Convert a JSON object or an array of objects into flattened CSV rows."""
    if isinstance(value, dict):
        return [flatten_object(value)]
    if isinstance(value, list):
        rows: list[dict[str, object]] = []
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                raise ValueError(
                    f"line {line_number}: JSON array item {index} is not an object"
                )
            rows.append(flatten_object(item))
        return rows
    return []


CSV_COLUMN_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")


def is_csv_header(fields: list[str]) -> bool:
    """Recognize a real header instead of any log line containing a delimiter."""
    cleaned = [field.strip().lstrip("\ufeff") for field in fields]
    return (
        len(cleaned) >= 2
        and len(cleaned) == len(set(cleaned))
        and all(CSV_COLUMN_NAME.fullmatch(field) for field in cleaned)
    )


def extract(
    input_path: Path,
    csv_path: Path,
    json_path: Path | None,
    delimiter: str,
) -> tuple[int, int, int]:
    csv_lines: list[str] = []
    flattened_json_rows: list[dict[str, object]] = []
    json_columns: list[str] = []
    seen_json_columns: set[str] = set()
    json_values: list[object] = []
    expected_fields: int | None = None
    csv_header: list[str] | None = None
    discarded = 0

    with input_path.open("r", encoding="utf-8", errors="replace", newline="") as source:
        for line_number, raw_line in enumerate(source, start=1):
            line = raw_line.rstrip("\r\n")
            if not line.strip():
                discarded += 1
                continue

            value = json_value(line)
            if value is not None:
                json_values.append(value)
                for row in json_rows(value, line_number):
                    flattened_json_rows.append(row)
                    for column in row:
                        if column not in seen_json_columns:
                            seen_json_columns.add(column)
                            json_columns.append(column)
                continue

            if delimiter in line:
                fields = next(csv.reader([line], delimiter=delimiter))
                if expected_fields is None:
                    # HTTP headers and cookies frequently contain semicolons.
                    # They are logs, not CSV, unless a plausible header has
                    # established the start of a delimited data block.
                    if not is_csv_header(fields):
                        discarded += 1
                        continue
                    csv_header = fields
                    expected_fields = len(fields)
                elif fields == csv_header:
                    # Multiple data blocks may repeat the same header. Keep a
                    # single header in the extracted CSV.
                    discarded += 1
                    continue
                if len(fields) != expected_fields:
                    raise ValueError(
                        f"line {line_number}: expected {expected_fields} CSV fields, "
                        f"found {len(fields)}"
                    )
                csv_lines.append(line)
                continue

            discarded += 1

    if not csv_lines and not flattened_json_rows:
        raise ValueError("no CSV records or JSON objects were found")

    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", encoding="utf-8", newline="\n") as destination:
        if flattened_json_rows:
            writer = csv.DictWriter(
                destination,
                fieldnames=json_columns,
                delimiter=delimiter,
                extrasaction="raise",
                lineterminator="\n",
            )
            writer.writeheader()
            writer.writerows(flattened_json_rows)
        else:
            for line in csv_lines:
                destination.write(line + "\n")

    if json_values and json_path is not None:
        json_path.parent.mkdir(parents=True, exist_ok=True)
        with json_path.open("w", encoding="utf-8", newline="\n") as destination:
            for value in json_values:
                destination.write(
                    json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
                )

    output_rows = len(flattened_json_rows) or len(csv_lines)
    return output_rows, len(json_values), discarded


def main() -> int:
    args = parse_args()
    if len(args.delimiter) != 1:
        print("error: --delimiter must be one character", file=sys.stderr)
        return 2

    csv_path = args.csv_output or args.input.with_suffix(".csv")
    json_path = args.json_output

    try:
        csv_count, json_count, discarded = extract(
            args.input, csv_path, json_path, args.delimiter
        )
    except (OSError, ValueError, csv.Error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    print(f"CSV:  {csv_count} data rows/lines -> {csv_path}")
    if json_count:
        print(f"JSON: {json_count} arrays/objects parsed")
        if args.json_output:
            print(f"JSONL copy: {json_path}")
    else:
        print("JSON: 0 values (no JSONL file created)")
    print(f"Logs/blank lines removed: {discarded}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
