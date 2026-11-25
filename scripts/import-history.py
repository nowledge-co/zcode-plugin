#!/usr/bin/env python3
"""Archive one stored ZCode conversation through Nowledge Mem's import CLI."""

import argparse
from contextlib import closing
from datetime import datetime, timezone
from hashlib import sha256
from itertools import groupby
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory


def read_session(path, session_id):
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("BEGIN")
        session_columns = {row[1] for row in db.execute("PRAGMA table_info(session)")}
        active = "AND time_deleted IS NULL" if "time_deleted" in session_columns else ""
        session = db.execute(
            f"SELECT title FROM session WHERE id = ? {active}", (session_id,)
        ).fetchone()
        if session is None:
            raise ValueError("Session was not found or has been deleted.")

        # Older databases lack sequence. Current databases order by sequence first.
        message_sequence = (
            "m.sequence IS NULL, m.sequence,"
            if any(row[1] == "sequence" for row in db.execute("PRAGMA table_info(message)"))
            else ""
        )
        part_sequence = (
            "p.sequence IS NULL, p.sequence,"
            if any(row[1] == "sequence" for row in db.execute("PRAGMA table_info(part)"))
            else ""
        )
        rows = db.execute(
            f"""
            SELECT m.id, m.time_created, json_extract(m.data, '$.role'),
                   json_extract(p.data, '$.text')
            FROM message m
            JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
            WHERE m.session_id = ?
              AND json_extract(m.data, '$.role') IN ('user', 'assistant')
              AND json_extract(p.data, '$.type') = 'text'
              AND json_type(p.data, '$.text') = 'text'
            ORDER BY {message_sequence} m.time_created, m.rowid,
                     {part_sequence} p.time_created, p.id
            """,
            (session_id,),
        )
        messages = []
        for (_, created_ms, role), parts in groupby(rows, key=lambda row: row[:3]):
            text = "\n\n".join(row[3] for row in parts if row[3].strip())
            if text:
                timestamp = datetime.fromtimestamp(created_ms / 1000, timezone.utc)
                messages.append({"role": role, "content": text, "timestamp": timestamp.isoformat()})
    if not messages:
        raise ValueError("No user or assistant text found in the selected session.")
    return {"title": session[0], "messages": messages}


def import_archive(thread_id, document):
    # Keep message text and titles out of argv. The temporary directory is private.
    with TemporaryDirectory(prefix="nmem-zcode-history-") as directory:
        path = Path(directory) / "conversation.json"
        path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
        result = subprocess.run(
            [
                "nmem", "--json", "t", "import", "--file", str(path),
                "--source", "zcode", "--id", thread_id,
            ],
            check=True, capture_output=True, encoding="utf-8",
        )
    response = json.loads(result.stdout)
    results = response.get("results", [])
    if not response.get("success") or len(results) != 1 or not results[0].get("success"):
        raise ValueError("Nowledge Mem did not confirm the import.")
    receipt = results[0]
    if receipt.get("thread_id") != thread_id or receipt.get("message_count") != len(document["messages"]):
        raise ValueError("Nowledge Mem returned an unexpected thread ID or message count.")
    return receipt["messages_added"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path.home() / ".zcode/cli/db/db.sqlite")
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--apply", action="store_true", help="Write the archive to Nowledge Mem.")
    args = parser.parse_args()
    try:
        document = read_session(args.db.expanduser(), args.session_id)
        # Archive identity comes from the snapshot so divergent histories cannot merge.
        identity = json.dumps([args.session_id, document["messages"]], sort_keys=True)
        thread_id = "zcode-history-" + sha256(identity.encode()).hexdigest()
        summary = {"thread_id": thread_id, "message_count": len(document["messages"])}
        if args.apply:
            summary["messages_added"] = import_archive(thread_id, document)
        print(json.dumps(summary))
    except subprocess.CalledProcessError as exc:
        parser.exit(1, f"Nowledge Mem import failed (nmem exit code {exc.returncode}).\n")
    except (OSError, sqlite3.Error, ValueError, OverflowError) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
