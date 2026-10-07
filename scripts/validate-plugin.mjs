#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(pluginRoot, ".zcode-plugin", "plugin.json");
const marketplacePath = join(pluginRoot, "marketplace.json");
const mcpPath = join(pluginRoot, ".mcp.json");
const expectedSkills = [
  "check-integration",
  "read-working-memory",
  "search-memory",
  "distill-memory",
  "save-handoff",
  "status",
];
const expectedCommands = [
  "nowledge-mem-save-handoff.md",
  "nowledge-mem-status.md",
  "nowledge-mem-sync-now.md",
];

function fail(message) {
  console.error(`ZCode plugin validation failed: ${message}`);
  process.exitCode = 1;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${detail}`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function validateManifest(manifest) {
  requireString(manifest.name, "manifest.name");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(manifest.name)) {
    throw new Error("manifest.name does not match the ZCode name format");
  }
  requireString(manifest.version, "manifest.version");
  if (manifest.version !== "0.2.2") {
    throw new Error("manifest.version must be 0.2.2");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error("manifest.version must be a semantic version");
  }
  requireString(manifest.description, "manifest.description");
  if (!manifest.author || typeof manifest.author !== "object") {
    throw new Error("manifest.author must be an object");
  }
  requireString(manifest.author.name, "manifest.author.name");
  if (manifest.commands !== "commands") {
    throw new Error('manifest.commands must be "commands"');
  }
  if (manifest.skills !== "skills") {
    throw new Error('manifest.skills must be "skills"');
  }
  if (manifest.hooks !== undefined) {
    throw new Error("standard hooks/hooks.json is auto-discovered; do not also declare manifest.hooks");
  }
  if (manifest.agents !== undefined) {
    throw new Error("this package does not declare custom agents");
  }
}

function validateMarketplace(marketplace, manifest) {
  if (!marketplace || typeof marketplace !== "object") {
    throw new Error("marketplace.json must contain an object");
  }
  requireString(marketplace.name, "marketplace.name");
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) {
    throw new Error("marketplace.json must declare exactly one plugin");
  }
  const plugin = marketplace.plugins[0];
  if (!plugin || plugin.name !== manifest.name || plugin.version !== manifest.version) {
    throw new Error("marketplace plugin name/version must match plugin.json");
  }
  if (plugin.source !== ".") {
    throw new Error("marketplace plugin source must be the standalone package root (.)");
  }
  if (plugin.repository !== "https://github.com/nowledge-co/zcode-plugin") {
    throw new Error("marketplace plugin repository must point to the standalone repository");
  }
}

function validateMcp(mcp) {
  if (!mcp.mcpServers || typeof mcp.mcpServers !== "object") {
    throw new Error(".mcp.json must contain mcpServers");
  }
  const names = Object.keys(mcp.mcpServers);
  if (names.length !== 1 || names[0] !== "nowledge-mem") {
    throw new Error(".mcp.json must declare exactly the nowledge-mem server");
  }
  const server = mcp.mcpServers["nowledge-mem"];
  if (!server || server.type !== "http") {
    throw new Error("nowledge-mem MCP server must use the ZCode http transport");
  }
  if (server.url !== "http://127.0.0.1:14242/mcp/") {
    throw new Error("nowledge-mem.url must use the local desktop endpoint");
  }
  if (!server.headers || Object.keys(server.headers).length !== 1 || server.headers.APP !== "ZCode") {
    throw new Error('nowledge-mem.headers must be exactly {"APP":"ZCode"}');
  }
  const serialized = JSON.stringify(mcp).toLowerCase();
  for (const forbidden of ["api-key", "api_key", "authorization", "bearer", "password", "secret"]) {
    if (serialized.includes(forbidden)) {
      throw new Error(`.mcp.json contains a credential field: ${forbidden}`);
    }
  }
}

function validateSkills() {
  const skillsRoot = join(pluginRoot, "skills");
  const actualSkills = readdirSync(skillsRoot).filter((name) =>
    statSync(join(skillsRoot, name)).isDirectory(),
  ).sort();
  if (JSON.stringify(actualSkills) !== JSON.stringify([...expectedSkills].sort())) {
    throw new Error(`skills must be exactly: ${expectedSkills.join(", ")}`);
  }
  for (const skillName of expectedSkills) {
    const skillPath = join(skillsRoot, skillName, "SKILL.md");
    const source = readFileSync(skillPath, "utf8");
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!match) {
      throw new Error(`${relative(pluginRoot, skillPath)} is missing YAML frontmatter`);
    }
    const frontmatter = match[1];
    const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (name !== skillName) {
      throw new Error(`${relative(pluginRoot, skillPath)} has frontmatter name ${name ?? "<missing>"}`);
    }
    if (!description || description.length > 1024) {
      throw new Error(`${relative(pluginRoot, skillPath)} needs a description of 1-1024 characters`);
    }
    if (/^name:\s*save-thread\s*$/m.test(frontmatter)) {
      throw new Error(`${relative(pluginRoot, skillPath)} must not declare save-thread`);
    }
  }
}

function validateCommands() {
  const commandsRoot = join(pluginRoot, "commands");
  const actualCommands = readdirSync(commandsRoot).filter((name) =>
    statSync(join(commandsRoot, name)).isFile(),
  ).sort();
  if (JSON.stringify(actualCommands) !== JSON.stringify([...expectedCommands].sort())) {
    throw new Error(`commands must be exactly: ${expectedCommands.join(", ")}`);
  }
  for (const commandName of expectedCommands) {
    const commandPath = join(commandsRoot, commandName);
    const source = readFileSync(commandPath, "utf8");
    if (!/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(source)) {
      throw new Error(`${relative(pluginRoot, commandPath)} is missing YAML frontmatter`);
    }
  }
}

function validateHooks() {
  const hooks = readJson(join(pluginRoot, "hooks", "hooks.json"), "hooks/hooks.json");
  const seenEvents = new Set();
  if (!hooks || typeof hooks !== "object" || !hooks.hooks || typeof hooks.hooks !== "object") {
    throw new Error("hooks/hooks.json must contain hooks");
  }
  for (const [eventName, matchers] of Object.entries(hooks.hooks)) {
    seenEvents.add(eventName);
    if (!Array.isArray(matchers) || matchers.length !== 1) {
      throw new Error(`${eventName} must declare exactly one matcher entry`);
    }
    const hooksForMatcher = matchers[0]?.hooks;
    if (!Array.isArray(hooksForMatcher) || hooksForMatcher.length !== 1) {
      throw new Error(`${eventName} must declare exactly one process hook`);
    }
    const hook = hooksForMatcher[0];
    if (hook.type !== "process" || hook.command !== "node") {
      throw new Error(`${eventName} hook must run as a node process`);
    }
    if (!Array.isArray(hook.args) || hook.args.length !== 1 || hook.args[0] !== "${ZCODE_PLUGIN_ROOT}/hooks/zcode-mem-hook.mjs") {
      throw new Error(`${eventName} hook args must point at hooks/zcode-mem-hook.mjs`);
    }
  }
  for (const eventName of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    if (!seenEvents.has(eventName)) {
      throw new Error(`hooks/hooks.json must declare ${eventName}`);
    }
  }
  const script = readFileSync(join(pluginRoot, "hooks", "zcode-mem-hook.mjs"), "utf8");
  for (const required of ["SessionStart", "UserPromptSubmit", "Stop", "transcript_path", "--from", "zcode"]) {
    if (!script.includes(required)) {
      throw new Error(`zcode-mem-hook.mjs is missing ${required}`);
    }
  }
}

try {
  const manifest = readJson(manifestPath, ".zcode-plugin/plugin.json");
  validateManifest(manifest);
  validateMarketplace(readJson(marketplacePath, "marketplace.json"), manifest);
  validateMcp(readJson(mcpPath, ".mcp.json"));
  validateSkills();
  validateCommands();
  validateHooks();
  for (const forbiddenPath of ["agents"]) {
    try {
      statSync(join(pluginRoot, forbiddenPath));
      throw new Error(`unexpected ${forbiddenPath}/ directory`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  console.log("ZCode plugin validation passed");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
