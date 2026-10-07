# Nowledge Mem for ZCode

> A ZCode Plugin package that adds Nowledge Mem MCP tools, reusable Skills, commands, and lifecycle hooks.

## Session-memory sync

Version 0.2.2 uses ZCode's hook contract:

- `SessionStart` reads the Nowledge Mem Context Bundle and injects it as additional context.
- `UserPromptSubmit` records the submitted prompt for the current session, then performs bounded memory recall for prompts that clearly need prior decisions, history, or connector context.
- `Stop` pairs those captured user prompts with ZCode's temporary hook `transcript_path` replies, then runs `nmem t sync --from zcode --session-dir <copied-transcript> --all-projects --apply`.

ZCode documents hook transcripts as temporary files that are available while the hook runs. The plugin copies them into plugin data before import. ZCode 0.16.5 compact transcripts contain assistant replies but not historical prompts, so only sessions started after upgrading to 0.2.1 can be reconstructed faithfully. Verify one short ZCode session after install because some older ZCode builds had public reports of `Stop` hooks not firing. If `Stop` does not fire, use the `nowledge-mem-sync-now` command when a hook context exposes `transcript_path`, or save a handoff summary.

## What it provides

After the plugin is enabled, ZCode can use the Nowledge Mem MCP server and these Skills:

- `read-working-memory` — read Context Bundle or Working Memory when starting or resuming work
- `search-memory` — proactively search memories and exact prior threads
- `distill-memory` — save durable decisions, procedures, learnings, and context
- `save-handoff` — save a structured, resumable summary when explicitly requested
- `status` — diagnose Nowledge Mem connectivity
- `check-integration` — verify setup and explain the capability contract

It also installs commands:

- `nowledge-mem-status` — check the local CLI or MCP connection
- `nowledge-mem-sync-now` — import the current hook transcript when `transcript_path` is available
- `nowledge-mem-save-handoff` — save an explicit resumable summary

This is a native `plugin + MCP + Skills + commands + hooks` integration. It does not claim pre-compaction capture, historical ZCode archive import, or lossless transcript import outside hook-provided transcripts.

## Manual installation

The plugin package includes `.zcode-plugin/plugin.json`, `.mcp.json`, `skills/`, `commands/`, `hooks/hooks.json`, and a `marketplace.json` catalog for the standalone repository `https://github.com/nowledge-co/zcode-plugin`.

### macOS/Linux

For normal installation, add the standalone repository's marketplace source in ZCode using the repository URL:

```text
https://github.com/nowledge-co/zcode-plugin
```

For local development or review, choose a stable checkout location and clone the standalone plugin repository:

```bash
PLUGIN_DIR="$HOME/src/zcode-plugin"
git clone https://github.com/nowledge-co/zcode-plugin.git "$PLUGIN_DIR"
```

If you already cloned it, update it later with:

```bash
git -C "$HOME/src/zcode-plugin" pull --ff-only
```

Create a persistent local marketplace directory under the user data directory. This is a project-recommended location, not a ZCode-defined default path:

```bash
PLUGIN_DIR="$HOME/src/zcode-plugin"
MARKETPLACE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/nowledge/zcode-marketplace"
mkdir -p "$MARKETPLACE_DIR"
python3 - "$MARKETPLACE_DIR" "$PLUGIN_DIR" <<'PY'
import json
import pathlib
import sys

marketplace_dir = pathlib.Path(sys.argv[1]).expanduser().resolve()
plugin_dir = pathlib.Path(sys.argv[2]).expanduser().resolve()
marketplace_dir.mkdir(parents=True, exist_ok=True)
marketplace = {
    "name": "nowledge-community-zcode-local",
    "description": "Local Nowledge Mem ZCode plugin source",
    "plugins": [{
        "name": "nowledge-mem-zcode",
        "version": "0.2.2",
        "description": "Native cross-tool memory for ZCode through Nowledge Mem MCP, Skills, commands, and hooks.",
        "source": {"source": "directory", "path": str(plugin_dir)},
    }],
}
(marketplace_dir / "marketplace.json").write_text(
    json.dumps(marketplace, indent=2) + "\n", encoding="utf-8"
)
print(f"Add this local marketplace directory in ZCode: {marketplace_dir}")
PY
```

Then open a ZCode workspace and:

1. Go to **Settings → Plugins**.
2. Select **Create → Add marketplace**.
3. Choose the persistent directory printed by the command above.
4. In the **Personal** section, install and enable `nowledge-mem-zcode`.
5. Reload or restart the ZCode Agent runtime.

The standalone repository's `marketplace.json` is the catalog used by the normal ZCode marketplace flow; `.zcode-plugin/plugin.json` remains the plugin manifest. The development-only generated catalog above is only for testing local, unpublished changes.

### Windows PowerShell

Clone or update the standalone plugin repository:

```powershell
$PluginDir = Join-Path $HOME "src\zcode-plugin"
git clone https://github.com/nowledge-co/zcode-plugin.git $PluginDir
# For an existing checkout instead:
# git -C $PluginDir pull --ff-only
```

Create the persistent user-owned marketplace directory and its catalog:

```powershell
$PluginDir = Join-Path $HOME "src\zcode-plugin"
$MarketplaceDir = Join-Path $env:LOCALAPPDATA "Nowledge\ZCode\marketplace"
New-Item -ItemType Directory -Force -Path $MarketplaceDir | Out-Null
@{
  name = "nowledge-community-zcode-local"
  description = "Local Nowledge Mem ZCode plugin source"
  plugins = @(@{
    name = "nowledge-mem-zcode"
    version = "0.2.2"
    description = "Native cross-tool memory for ZCode through Nowledge Mem MCP, Skills, commands, and hooks."
    source = @{
      source = "directory"
      path = (Resolve-Path $PluginDir).Path
    }
  })
} | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $MarketplaceDir "marketplace.json")
Write-Host "Add this local marketplace directory in ZCode: $MarketplaceDir"
```

In ZCode, use **Settings → Plugins → Create → Add marketplace**, choose `$MarketplaceDir`, install and enable `nowledge-mem-zcode`, and reload the Agent runtime.

### Updating the plugin and adding future plugins

Keep both the plugin checkout and the user-owned marketplace directory at stable, accessible paths. ZCode does not document whether local marketplace sources are copied, cached, watched, or referenced directly, nor does it document a default storage path. Do not delete or move the source if you want the documented refresh workflow to keep working.

To update this plugin:

```bash
git -C "$HOME/src/zcode-plugin" pull --ff-only
```

Then open **Settings → Plugins → Marketplace sources** and choose **Refresh this marketplace**. Use **Manage installed → Check for updates** when ZCode offers that action, and reload the Agent runtime if components do not appear immediately.

To add another local plugin in the future, edit the persistent marketplace's `marketplace.json` and append another `plugins[]` entry with a unique `name`, version, description, and a valid absolute `directory` source path. Refresh the marketplace, then install and enable the new plugin from the Personal section. ZCode's documentation does not promise that a newly listed local plugin is automatically installed or that an existing install is automatically upgraded.

For remote SSH/WSL workspaces, local plugins do not automatically move with the workspace. ZCode documents that marketplace plugins are reinstalled remotely and that the remote environment must be able to reach the marketplace source. Keep the source available on the remote side or use a reachable GitHub/Git source instead.

## Mem connection

The package's default `.mcp.json` uses the local Nowledge Mem Desktop endpoint:

```text
http://127.0.0.1:14242/mcp/
```

Start Nowledge Mem Desktop and verify the CLI when using local mode:

```bash
nmem --json status
```

For Cloud, Access Anywhere, self-hosted, or another remote endpoint, configure the ZCode-owned MCP settings rather than editing the installed package. Keep the endpoint and credential in the user's secure Nowledge Mem client configuration or environment (`NMEM_API_URL` and `NMEM_API_KEY`), then generate the host-owned MCP block without putting the key in shell history:

```bash
nmem config mcp show --host zcode
```

Paste the generated MCP block into ZCode's own MCP settings and reload the Agent runtime. API keys are intentionally absent from this repository and must not be passed as command-line arguments or written to logs. Direct MCP clients do not automatically inherit `~/.nowledge-mem/config.json`.

## Capability contract

| Capability | ZCode behavior in 0.2.0 |
|---|---|
| Context Bundle / Working Memory | Skill/MCP access plus `SessionStart` hook injection |
| Memory and thread search | Skill/MCP access plus conservative `UserPromptSubmit` recall |
| Distillation | Guided; search before update/add |
| Status | CLI fallback plus MCP server tools |
| Commands | Status, sync-now, and handoff commands |
| Handoff | Explicit structured summary fallback |
| Hook transcript capture | `Stop` hook copies temporary `transcript_path` JSONL and imports it with `nmem t sync --from zcode` |
| Pre-compaction capture | Not provided |
| Historical archive import | Not provided without an explicit hook transcript path |

A handoff is not a transcript. Do not describe `save-handoff` as lossless session capture. Do not claim transcript import succeeded unless `nmem t sync --from zcode` succeeded.

## Customize without editing the plugin

Do not modify files under ZCode's installed plugin cache. Put project-specific memory guidance in the host's user/project instruction surface when available, or use ZCode's own settings and prompt customization. This keeps changes durable across plugin updates.

## Permissions and security

Enabling a third-party ZCode plugin grants it the permissions provided by its declared components. Review the manifest, `.mcp.json`, Skills, commands, and hooks before enabling it. This package runs a local Node hook script that invokes `nmem`; its MCP server still has the access granted by the ZCode MCP client and the endpoint you configure.

## Development

Validate the self-contained package without credentials or a running ZCode UI:

```bash
node scripts/validate-plugin.mjs
```

The repository also has a static integration contract test. There is currently no verified headless ZCode plugin harness, so a successful static test is not a claim that a given ZCode desktop build fired every hook. After install, run one short session and check that the imported thread appears in Nowledge Mem.
