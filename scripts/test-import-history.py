#!/usr/bin/env python3

from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


SCRIPT = Path(__file__).with_name("import-history.py")


class ImportHistoryTest(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.db = Path(directory.name) / "sessions ?#.sqlite"

    def fixture(self, current):
        sequence = ", sequence INTEGER" if current else ""
        with sqlite3.connect(self.db) as db:
            db.executescript(f"""
                CREATE TABLE session (id TEXT, title TEXT, time_deleted INTEGER);
                CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT{sequence});
                CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT,
                                   time_created INTEGER, data TEXT{sequence});
                INSERT INTO session VALUES ('s1', 'Example', NULL), ('deleted', 'Deleted', 1);
            """)
            # Current schema orders by sequence, even when timestamps disagree.
            first, second = (2, 1) if current else (1, 2)
            columns = ", sequence" if current else ""
            placeholder = ", ?" if current else ""
            messages = [
                ("a", "s1", second, '{"role":"assistant"}', 2),
                ("u", "s1", first, '{"role":"user"}', 1),
            ]
            parts = [
                ("p2", "a", "s1", second, '{"type":"text","text":"Second"}', 2),
                ("p1", "a", "s1", first, '{"type":"text","text":"First"}', 1),
                ("p3", "u", "s1", 1, '{"type":"text","text":"Question"}', 1),
                ("p4", "u", "s1", 2, '{"type":"tool","text":"ignored"}', 2),
            ]
            db.executemany(
                f"INSERT INTO message (id, session_id, time_created, data{columns}) "
                f"VALUES (?, ?, ?, ?{placeholder})",
                messages if current else [row[:-1] for row in messages],
            )
            db.executemany(
                f"INSERT INTO part (id, message_id, session_id, time_created, data{columns}) "
                f"VALUES (?, ?, ?, ?, ?{placeholder})",
                parts if current else [row[:-1] for row in parts],
            )
        return first, second

    def run_script(self, session_id):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--db", str(self.db), "--session-id", session_id],
            capture_output=True, text=True,
        )

    def assert_archive_order(self, current):
        first, second = self.fixture(current)
        original = self.db.read_bytes()
        result = self.run_script("s1")
        self.assertEqual(result.returncode, 0, result.stderr)
        messages = [
            {"role": "user", "content": "Question", "timestamp": f"1970-01-01T00:00:00.00{first}000+00:00"},
            {"role": "assistant", "content": "First\n\nSecond", "timestamp": f"1970-01-01T00:00:00.00{second}000+00:00"},
        ]
        digest = sha256(json.dumps(["s1", messages], sort_keys=True).encode()).hexdigest()
        self.assertEqual(json.loads(result.stdout), {
            "thread_id": "zcode-history-" + digest,
            "message_count": 2,
        })
        self.assertEqual(self.run_script("s1").stdout, result.stdout)
        self.assertEqual(self.db.read_bytes(), original)

    def test_current_schema(self):
        self.assert_archive_order(current=True)

    def test_legacy_schema(self):
        self.assert_archive_order(current=False)

    def test_deleted_and_unknown_sessions(self):
        self.fixture(current=True)
        for session_id in ("deleted", "missing", "' OR 1=1 --"):
            with self.subTest(session_id=session_id):
                result = self.run_script(session_id)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Session was not found or has been deleted", result.stderr)


if __name__ == "__main__":
    unittest.main()
