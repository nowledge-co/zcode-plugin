---
description: Archive one stored ZCode conversation from the local SQLite database.
---

Use the installed plugin's `scripts/import-history.py` with the session ID specified by the user. Use the current ZCode session ID only if the user explicitly requests the current session. Pass the user's database path as `--db` when provided.

Use the script path from this command:

```!
python3 "${ZCODE_PLUGIN_ROOT}/scripts/import-history.py" --help
```

Pass `--session-id` to preview. Add `--apply` when the user requests the import. Pass the session ID and database path as literal arguments. Report the archive thread ID and imported message count.
