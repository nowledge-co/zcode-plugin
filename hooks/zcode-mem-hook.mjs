#!/usr/bin/env node
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const MAX_CONTEXT_CHARS = 6000;
const RECALL_PROMPT_RE =
  /\b(previous|prior|history|remember|decision|like before|regression|release|plugin|connector|sync|hook|thread|memory|context)\b/i;

function readStdin() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    raw += chunk;
  });
  return new Promise((resolve) => {
    process.stdin.on("end", () => resolve(raw));
  });
}

function runNmem(args, options = {}) {
  return spawnSync("nmem", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: options.timeoutMs ?? 12000,
    env: {
      ...process.env,
      APP: "ZCode",
      NMEM_SOURCE_APP: "zcode",
    },
  });
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    for (const key of ["text", "content", "message", "value"]) {
      const text = textOf(value[key]);
      if (text) return text;
    }
  }
  return "";
}

function hookSessionId(input) {
  return String(input.session_id || input.sessionId || "").trim();
}

function pluginDataDir() {
  return process.env.ZCODE_PLUGIN_DATA
    || process.env.CLAUDE_PLUGIN_DATA
    || join(tmpdir(), "nowledge-mem-zcode");
}

function sessionFileName(sessionId) {
  return `${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}.jsonl`;
}

function pendingPromptPath(sessionId) {
  const dir = join(pluginDataDir(), "pending-prompts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, sessionFileName(sessionId));
}

function hookTimestamp(input) {
  const timestamp = input.timestamp || input.created_at || input.createdAt || input.time;
  return typeof timestamp === "string" && timestamp.trim() ? timestamp : new Date().toISOString();
}

function recordPrompt(input) {
  const prompt = String(input.prompt || "").trim();
  const sessionId = hookSessionId(input);
  if (!prompt || !sessionId) return;
  appendFileSync(
    pendingPromptPath(sessionId),
    `${JSON.stringify({
      role: "user",
      prompt_id: randomUUID(),
      session_id: sessionId,
      cwd: input.cwd,
      timestamp: hookTimestamp(input),
      content: prompt,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function readJsonEvents(body) {
  const trimmed = body.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter((event) => event && typeof event === "object");
    for (const key of ["messages", "events"]) {
      if (Array.isArray(parsed?.[key])) return parsed[key].filter((event) => event && typeof event === "object");
    }
  } catch {
    // ZCode hook transcripts are normally JSONL.
  }
  return body.split("\n").flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event && typeof event === "object" ? [event] : [];
    } catch {
      return [];
    }
  });
}

function eventRole(event) {
  const value = event?.message?.role
    || event?.role
    || event?.messageType
    || event?.metadata?.messageType
    || event?.type;
  if (typeof value !== "string") return "";
  if (value.toLowerCase() === "human") return "user";
  if (value.toLowerCase() === "ai") return "assistant";
  return value.toLowerCase();
}

function readPendingPrompts(sessionId) {
  try {
    return readJsonEvents(readFileSync(pendingPromptPath(sessionId), "utf8"))
      .filter((event) => eventRole(event) === "user");
  } catch {
    return [];
  }
}

function clearPendingPrompts(sessionId) {
  try {
    unlinkSync(pendingPromptPath(sessionId));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      process.stderr.write(`[nowledge-mem-zcode] cannot clear captured prompts: ${error.message}\n`);
    }
  }
}

function assistantEvent(sessionId, input, content) {
  return {
    role: "assistant",
    session_id: sessionId,
    cwd: input.cwd,
    timestamp: hookTimestamp(input),
    content,
  };
}

// Issue #5: `nmem t sync` reconciles an existing thread positionally, so
// every sync must carry the full conversation. Overwriting the per-session
// transcript with the latest turn made every sync after the first report
// "unchanged" and silently dropped the turn. Accumulate turns instead, with
// suffix-aware merge: a Stop can re-assert turns already stored (a retry
// after a failed sync re-pairs the same pending prompt), and reconstructed
// assistant timestamps may drift between firings. User prompt identity is
// persisted at submission so a new turn with identical text still appends.
function sameTranscriptEvents(a, b) {
  const role = eventRole(a);
  if (role !== eventRole(b) || textOf(a) !== textOf(b)) return false;
  if (role !== "user") return true;
  if (a.prompt_id || b.prompt_id) return a.prompt_id === b.prompt_id;
  // Pending prompts captured before prompt IDs were introduced already have
  // stable timestamps. Complete native transcripts may omit both fields.
  return a.timestamp === b.timestamp;
}

function appendTranscriptEvents(path, body) {
  const incoming = readJsonEvents(body);
  if (incoming.length === 0) return;
  let existing = [];
  try {
    existing = readJsonEvents(readFileSync(path, "utf8"));
  } catch {
    existing = [];
  }

  const maxOverlap = Math.min(existing.length, incoming.length);
  let overlap = 0;
  for (let candidate = maxOverlap; candidate > 0; candidate -= 1) {
    const suffix = existing.slice(existing.length - candidate);
    const prefix = incoming.slice(0, candidate);
    if (suffix.every((event, index) => sameTranscriptEvents(event, prefix[index]))) {
      overlap = candidate;
      break;
    }
  }
  const merged = existing.slice(0, existing.length - overlap).concat(incoming);
  writeFileSync(path, merged.map((event) => JSON.stringify(event)).join("\n").concat("\n"), "utf8");
}

function completeTranscript(input, body, sessionId) {
  const events = readJsonEvents(body);
  if (events.some((event) => eventRole(event) === "user")) return body;

  const lastAssistant = textOf(input.last_assistant_message || input.lastAssistantMessage).trim();
  const assistants = events.filter((event) => eventRole(event) === "assistant");
  if (lastAssistant && !assistants.some((event) => textOf(event).includes(lastAssistant))) {
    assistants.push(assistantEvent(sessionId, input, lastAssistant));
  }

  const prompts = readPendingPrompts(sessionId);
  if (prompts.length === 0 || assistants.length === 0) return null;
  // PATCH(issue#5): pair the newest prompts with the newest assistant
  // messages. Older unpaired prompts belong to turns whose replies are no
  // longer present in ZCode's compact Stop transcript; returning null here
  // used to stall the session's sync forever once a single sync failed.
  const pairCount = Math.min(prompts.length, assistants.length);
  if (pairCount < prompts.length) {
    process.stderr.write(
      `[nowledge-mem-zcode] pairing latest ${pairCount} prompt(s); ${prompts.length - pairCount} older prompt(s) have no capturable reply\n`,
    );
  }
  const matchedPrompts = prompts.slice(-pairCount);
  const matchedAssistants = assistants.slice(-pairCount);

  return matchedPrompts.flatMap((prompt, index) => [prompt, matchedAssistants[index]])
    .map((event) => JSON.stringify(event))
    .join("\n")
    .concat("\n");
}

function writeAdditionalContext(eventName, additionalContext) {
  const trimmed = String(additionalContext || "").trim().slice(0, MAX_CONTEXT_CHARS);
  if (!trimmed) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: trimmed,
    },
  }));
}

function summarizeContextBundle(payload) {
  if (!payload || typeof payload !== "object") return "";
  const rendered = payload.markdown || payload.content || payload.context || payload.working_memory;
  if (typeof rendered === "string" && rendered.trim()) return rendered.trim();
  return JSON.stringify(payload, null, 2);
}

function sessionStart(input) {
  const args = ["--json", "context", "--source-app", "zcode"];
  const result = runNmem(args, { timeoutMs: 10000 });
  if (result.status !== 0 || !result.stdout.trim()) return;
  try {
    const payload = JSON.parse(result.stdout);
    const context = summarizeContextBundle(payload);
    writeAdditionalContext("SessionStart", context);
  } catch {
    // Hook diagnostics belong on stderr; stdout must remain protocol JSON.
    process.stderr.write("[nowledge-mem-zcode] context output was not JSON\n");
  }
}

function promptRecall(input) {
  recordPrompt(input);
  const prompt = String(input.prompt || "").trim();
  if (!prompt || !RECALL_PROMPT_RE.test(prompt)) return;
  const result = runNmem(["--json", "m", "search", prompt, "-n", "5"], { timeoutMs: 10000 });
  if (result.status !== 0 || !result.stdout.trim()) return;
  try {
    const payload = JSON.parse(result.stdout);
    const memories = Array.isArray(payload.memories) ? payload.memories.slice(0, 5) : [];
    if (!memories.length) return;
    const lines = memories.map((memory, index) => {
      const title = memory.title || `Memory ${index + 1}`;
      const content = memory.content || memory.snippet || "";
      return `- ${title}: ${String(content).replace(/\s+/g, " ").slice(0, 450)}`;
    });
    writeAdditionalContext(
      "UserPromptSubmit",
      `Relevant Nowledge Mem context for this request:\n${lines.join("\n")}`,
    );
  } catch {
    process.stderr.write("[nowledge-mem-zcode] memory search output was not JSON\n");
  }
}

function copiedTranscriptPath(input) {
  const transcript = String(input.transcript_path || input.transcriptPath || "").trim();
  if (!transcript) return null;
  let body = "";
  try {
    body = readFileSync(transcript, "utf8");
  } catch (error) {
    process.stderr.write(`[nowledge-mem-zcode] cannot read transcript_path: ${error.message}\n`);
    return null;
  }

  const sessionId = hookSessionId(input);
  if (!sessionId) {
    process.stderr.write("[nowledge-mem-zcode] cannot capture a transcript without session_id\n");
    return null;
  }
  body = completeTranscript(input, body, sessionId);
  if (body === null) return null;

  const base = process.env.ZCODE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || mkdtempSync(join(tmpdir(), "nmem-zcode-"));
  const dir = join(base, "transcripts");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, sessionFileName(sessionId));
  // PATCH(issue#5): accumulate turns instead of overwriting, so each sync
  // carries the full conversation (see appendTranscriptEvents above).
  appendTranscriptEvents(out, body);
  return out;
}

function stopCapture(input) {
  const transcript = copiedTranscriptPath(input);
  if (!transcript) return;
  const sessionId = String(input.session_id || input.sessionId || "").trim();
  const args = [
    "--json",
    "t",
    "sync",
    "--from",
    "zcode",
    "--session-dir",
    transcript,
    "--all-projects",
    "--apply",
  ];
  if (sessionId) args.push("--session-id", sessionId);
  const result = runNmem(args, { timeoutMs: 18000 });
  if (result.status === 0) {
    clearPendingPrompts(sessionId);
  } else {
    process.stderr.write(`[nowledge-mem-zcode] thread sync failed: ${result.stderr || result.stdout}\n`);
  }
}

const raw = await readStdin();
let input = {};
try {
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  process.stderr.write("[nowledge-mem-zcode] hook input was not JSON\n");
}

const eventName = String(input.hook_event_name || input.hookEventName || "");
try {
  if (eventName === "SessionStart") {
    sessionStart(input);
  } else if (eventName === "UserPromptSubmit") {
    promptRecall(input);
  } else if (eventName === "Stop") {
    stopCapture(input);
  }
} catch (error) {
  process.stderr.write(`[nowledge-mem-zcode] hook failed: ${error instanceof Error ? error.message : String(error)}\n`);
}
