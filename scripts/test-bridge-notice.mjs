import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const hook = new URL('../hooks/bridge-notice.mjs', import.meta.url);
test('actual session consumes local hints; missing session and old CLI stay quiet', {skip: process.platform === 'win32'}, t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-hook-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const log = join(dir, 'argv.json');
  const cli = join(dir, 'nmem');
  writeFileSync(cli, `#!/bin/sh
printf '%s\\n' "$@" > "$BRIDGE_FIXTURE_LOG"
printf '%s' '{"notices":[{"hint":"Synthetic pending mail","args":["--agent-context=fixture","bridge","inbox"]}]}'
`, {mode:0o700});
  // Prepare the disposable executable before testing the bounded hook itself.
  assert.equal(spawnSync(cli, [], {env:{...process.env, BRIDGE_FIXTURE_LOG:log}}).status, 0);
  rmSync(log);
  const run = input => {
    const result = spawnSync(process.execPath, [hook.pathname], {input:JSON.stringify(input), encoding:'utf8', env:{...process.env, NMEM_CLI_PATH:cli, BRIDGE_FIXTURE_LOG:log, NMEM_NO_MAILBOX_NOTICE:'0', NMEM_BRIDGE_INBOX_ON_START:'0', NMEM_AGENT_CONTEXT:''}});
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(run({hook_event_name:'UserPromptSubmit'}).hookSpecificOutput, undefined);
  assert.equal(existsSync(log), false);
  const session='opaque & "quoted"';
  assert.match(run({hook_event_name:'UserPromptSubmit',session_id:session}).hookSpecificOutput.additionalContext, /Synthetic pending mail/);
  assert.deepEqual(readFileSync(log,'utf8').trim().split('\n'), ['--json','bridge','notices','check','--host=zcode','--session-id='+session]);
  writeFileSync(cli, '#!/bin/sh\nexit 2\n', {mode:0o700});
  assert.equal(run({hook_event_name:'UserPromptSubmit',session_id:session}).hookSpecificOutput, undefined);
});
