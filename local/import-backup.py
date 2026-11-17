#!/usr/bin/env python3
"""Import a QBReader Extended JSON backup into a local SQLite database."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import struct
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


COLLECTIONS = ("sets", "packets", "tossups", "bonuses")


def decode_extended_json(value):
    if isinstance(value, list):
        return [decode_extended_json(item) for item in value]
    if not isinstance(value, dict):
        return value

    if len(value) == 1:
        if "$oid" in value:
            return value["$oid"]
        if "$numberInt" in value or "$numberLong" in value:
            return int(value.get("$numberInt", value.get("$numberLong")))
        if "$numberDouble" in value:
            raw = value["$numberDouble"]
            return {"NaN": float("nan"), "Infinity": float("inf"), "-Infinity": float("-inf")}.get(raw, float(raw))
        if "$numberDecimal" in value:
            return value["$numberDecimal"]
        if "$date" in value:
            date_value = value["$date"]
            if isinstance(date_value, dict):
                millis = int(date_value.get("$numberLong", date_value.get("$numberInt")))
                instant = datetime.fromtimestamp(millis / 1000, timezone.utc)
                return instant.isoformat(timespec="milliseconds").replace("+00:00", "Z")
            return date_value

    return {key: decode_extended_json(item) for key, item in value.items()}


def bson_document_count(path: Path) -> int:
    """Count raw BSON documents and reject truncated or malformed streams."""
    total_bytes = path.stat().st_size
    count = 0
    offset = 0
    with path.open("rb") as stream:
        while offset < total_bytes:
            header = stream.read(4)
            if len(header) != 4:
                raise ValueError(f"Truncated BSON length at byte {offset}: {path}")
            length = struct.unpack("<i", header)[0]
            if length < 5 or offset + length > total_bytes:
                raise ValueError(f"Invalid BSON document length {length} at byte {offset}: {path}")
            stream.seek(length - 4, os.SEEK_CUR)
            offset += length
            count += 1
    if offset != total_bytes:
        raise ValueError(f"BSON file ended at an unexpected offset: {path}")
    return count


def read_documents(path: Path):
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if line.strip():
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(f"Invalid JSON at {path}:{line_number}: {error}") from error
                if not isinstance(raw, dict):
                    raise ValueError(f"Expected one document per line at {path}:{line_number}")
                document = decode_extended_json(raw)
                if not isinstance(document.get("_id"), str):
                    raise ValueError(f"Missing Extended JSON ObjectId at {path}:{line_number}")
                yield document


def question_values(collection: str, doc: dict):
    packet = doc.get("packet") or {}
    question_set = doc.get("set") or {}
    common = (
        doc["_id"],
        packet.get("_id"),
        question_set.get("_id"),
        question_set.get("name"),
        packet.get("number"),
        doc.get("number"),
        question_set.get("year"),
        doc.get("difficulty"),
        doc.get("category"),
        doc.get("subcategory"),
        doc.get("alternate_subcategory"),
        1 if question_set.get("standard") else 0,
    )
    doc_json = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    if collection == "tossups":
        return common + (doc.get("question_sanitized", ""), doc.get("answer_sanitized", ""), doc_json)
    parts = doc.get("parts_sanitized", [])
    return common + (
        doc.get("leadin_sanitized", ""),
        json.dumps(parts, ensure_ascii=False, separators=(",", ":")),
        json.dumps(doc.get("answers_sanitized", []), ensure_ascii=False, separators=(",", ":")),
        len(parts),
        doc_json,
    )


def add_question_search_rows(collection: str, doc: dict):
    question_id = doc["_id"]
    if collection == "tossups":
        return [
            (question_id, "question", doc.get("question_sanitized", "")),
            (question_id, "answer", doc.get("answer_sanitized", "")),
        ]
    rows = [(question_id, "question", doc.get("leadin_sanitized", ""))]
    rows.extend((question_id, "question", text) for text in doc.get("parts_sanitized", []))
    rows.extend((question_id, "answer", text) for text in doc.get("answers_sanitized", []))
    return rows


def create_schema(connection: sqlite3.Connection):
    connection.executescript("""
        CREATE TABLE sets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            year INTEGER,
            difficulty INTEGER,
            standard INTEGER NOT NULL DEFAULT 0,
            doc_json TEXT NOT NULL
        );
        CREATE TABLE packets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            set_id TEXT,
            set_name TEXT NOT NULL,
            number INTEGER NOT NULL,
            doc_json TEXT NOT NULL
        );
        CREATE TABLE tossups (
            id TEXT PRIMARY KEY,
            packet_id TEXT,
            set_id TEXT,
            set_name TEXT NOT NULL,
            packet_number INTEGER NOT NULL,
            number INTEGER NOT NULL,
            set_year INTEGER,
            difficulty INTEGER,
            category TEXT,
            subcategory TEXT,
            alternate_subcategory TEXT,
            standard INTEGER NOT NULL DEFAULT 0,
            question_sanitized TEXT NOT NULL,
            answer_sanitized TEXT NOT NULL,
            doc_json TEXT NOT NULL
        );
        CREATE TABLE bonuses (
            id TEXT PRIMARY KEY,
            packet_id TEXT,
            set_id TEXT,
            set_name TEXT NOT NULL,
            packet_number INTEGER NOT NULL,
            number INTEGER NOT NULL,
            set_year INTEGER,
            difficulty INTEGER,
            category TEXT,
            subcategory TEXT,
            alternate_subcategory TEXT,
            standard INTEGER NOT NULL DEFAULT 0,
            leadin_sanitized TEXT NOT NULL,
            parts_sanitized_json TEXT NOT NULL,
            answers_sanitized_json TEXT NOT NULL,
            part_count INTEGER NOT NULL,
            doc_json TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE question_search USING fts5(
            question_id UNINDEXED,
            field UNINDEXED,
            value,
            tokenize='trigram'
        );
    """)


def insert_sets(connection, path):
    rows = []
    for doc in read_documents(path):
        rows.append((
            doc["_id"], doc.get("name", ""), doc.get("year"), doc.get("difficulty"),
            1 if doc.get("standard") else 0,
            json.dumps(doc, ensure_ascii=False, separators=(",", ":")),
        ))
        if len(rows) == 1000:
            connection.executemany("INSERT INTO sets VALUES (?, ?, ?, ?, ?, ?)", rows)
            rows.clear()
    if rows:
        connection.executemany("INSERT INTO sets VALUES (?, ?, ?, ?, ?, ?)", rows)


def insert_packets(connection, path):
    rows = []
    for doc in read_documents(path):
        question_set = doc.get("set") or {}
        rows.append((
            doc["_id"], doc.get("name", ""), question_set.get("_id"),
            question_set.get("name", ""), doc.get("number", 0),
            json.dumps(doc, ensure_ascii=False, separators=(",", ":")),
        ))
        if len(rows) == 1000:
            connection.executemany("INSERT INTO packets VALUES (?, ?, ?, ?, ?, ?)", rows)
            rows.clear()
    if rows:
        connection.executemany("INSERT INTO packets VALUES (?, ?, ?, ?, ?, ?)", rows)


def insert_questions(connection, collection, path):
    rows = []
    insert_sql = """
        INSERT INTO {table} (
            id, packet_id, set_id, set_name, packet_number, number, set_year,
            difficulty, category, subcategory, alternate_subcategory, standard,
            {specific_columns}, doc_json
        ) VALUES ({placeholders})
    """
    if collection == "tossups":
        sql = insert_sql.format(
            table=collection,
            specific_columns="question_sanitized, answer_sanitized",
            placeholders=", ".join(["?"] * 15),
        )
    else:
        sql = insert_sql.format(
            table=collection,
            specific_columns="leadin_sanitized, parts_sanitized_json, answers_sanitized_json, part_count",
            placeholders=", ".join(["?"] * 17),
        )
    for doc in read_documents(path):
        rows.append(question_values(collection, doc))
        if len(rows) == 500:
            connection.executemany(sql, rows)
            rows.clear()
    if rows:
        connection.executemany(sql, rows)


def build_fts(connection, collection, path):
    rows = []
    for doc in read_documents(path):
        rows.extend(add_question_search_rows(collection, doc))
        if len(rows) >= 2000:
            connection.executemany(
                "INSERT INTO question_search (question_id, field, value) VALUES (?, ?, ?)",
                rows,
            )
            rows.clear()
    if rows:
        connection.executemany(
            "INSERT INTO question_search (question_id, field, value) VALUES (?, ?, ?)",
            rows,
        )


def create_indexes(connection):
    connection.executescript("""
        CREATE UNIQUE INDEX sets_year_name ON sets(year DESC, name ASC);
        CREATE INDEX packets_set_id ON packets(set_id);
        CREATE UNIQUE INDEX packets_set_name_number ON packets(set_name, number);
        CREATE INDEX tossups_search_filters ON tossups(
            difficulty, category, subcategory, alternate_subcategory, set_year
        );
        CREATE UNIQUE INDEX tossups_packet_number ON tossups(packet_id, number);
        CREATE INDEX tossups_play_order ON tossups(set_name COLLATE BINARY DESC, packet_number, number);
        CREATE INDEX bonuses_search_filters ON bonuses(
            difficulty, category, subcategory, alternate_subcategory, set_year
        );
        CREATE UNIQUE INDEX bonuses_packet_number ON bonuses(packet_id, number);
        CREATE INDEX bonuses_play_order ON bonuses(set_name COLLATE BINARY DESC, packet_number, number);
        ANALYZE;
    """)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backup", type=Path, help="QBReader backup directory with JSON, BSON, and metadata files")
    parser.add_argument("--output", type=Path, default=Path("questions.sqlite"), help="destination SQLite file (default: questions.sqlite)")
    args = parser.parse_args()
    backup = args.backup.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if not backup.is_dir():
        parser.error(f"Backup directory does not exist: {backup}")
    if output.exists():
        parser.error(f"Output already exists; move it aside before importing: {output}")
    for collection in COLLECTIONS:
        for suffix in ("json", "bson", "metadata.json"):
            if not (backup / f"{collection}.{suffix}").is_file():
                parser.error(f"Incomplete backup: missing {collection}.{suffix}")
    if not (backup / "prelude.json").is_file():
        parser.error("Incomplete backup: missing prelude.json")

    prelude = json.loads((backup / "prelude.json").read_text(encoding="utf-8"))
    print(f"Backup MongoDB {prelude.get('ServerVersion', 'unknown')}; tools {prelude.get('ToolVersion', 'unknown')}")
    for collection in COLLECTIONS:
        bson_count = bson_document_count(backup / f"{collection}.bson")
        json_count = sum(1 for _ in read_documents(backup / f"{collection}.json"))
        if bson_count != json_count:
            parser.error(f"{collection} count mismatch: BSON has {bson_count:,}, JSON has {json_count:,}")
        print(f"Verified {collection}: {json_count:,} documents in JSON and BSON")

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = output.with_name(output.name + ".next")
    if staging.exists():
        parser.error(f"Staging database already exists; inspect or remove it first: {staging}")

    connection = sqlite3.connect(staging)
    try:
        connection.execute("PRAGMA journal_mode=OFF")
        connection.execute("PRAGMA synchronous=OFF")
        connection.execute("PRAGMA temp_store=MEMORY")
        create_schema(connection)
        import_started = time.perf_counter()
        connection.execute("BEGIN")
        insert_sets(connection, backup / "sets.json")
        insert_packets(connection, backup / "packets.json")
        insert_questions(connection, "tossups", backup / "tossups.json")
        insert_questions(connection, "bonuses", backup / "bonuses.json")
        connection.commit()
        import_elapsed = time.perf_counter() - import_started
        print(f"Data import: {import_elapsed:.2f}s")

        indexing_started = time.perf_counter()
        connection.execute("BEGIN")
        build_fts(connection, "tossups", backup / "tossups.json")
        build_fts(connection, "bonuses", backup / "bonuses.json")
        create_indexes(connection)
        connection.commit()
        indexing_elapsed = time.perf_counter() - indexing_started
        connection.close()
        os.replace(staging, output)
        print(f"Metadata and FTS5 indexing: {indexing_elapsed:.2f}s")
        print(f"SQLite file: {output} ({output.stat().st_size / (1024 ** 3):.2f} GiB)")
        print("Counts:", end=" ")
        check = sqlite3.connect(f"file:{output}?mode=ro", uri=True)
        print(", ".join(f"{name}={check.execute(f'SELECT count(*) FROM {name}').fetchone()[0]:,}" for name in COLLECTIONS))
        check.close()
    except Exception:
        connection.close()
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Import failed: {error}", file=sys.stderr)
        raise
