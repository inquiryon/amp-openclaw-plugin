// Tier 1: the real-host test and its tool-call driver must never touch the
// machine's legacy shared session file. The plugin stopped using it (A13), so
// deleting or rewriting it only risks the developer's real state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = ['real-openclaw.test.mjs', 'fixtures/drive_tool_call.mjs'];

for (const rel of FILES) {
  test(`${rel} does not reference the legacy /tmp session file`, () => {
    const src = fs.readFileSync(path.join(HERE, rel), 'utf8');
    assert.doesNotMatch(src, /amp-session-state|LEGACY_SESSION_FILE/);
  });
}
