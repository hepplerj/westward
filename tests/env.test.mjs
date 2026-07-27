import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../scripts/lib/env.mjs';

function withTempEnvFile(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'westward-env-test-'));
  const path = join(dir, '.env');
  if (contents !== null) writeFileSync(path, contents);
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadEnv parses KEY=value lines into process.env', () => {
  withTempEnvFile('FOO_TEST_KEY=hello\nBAR_TEST_KEY=world\n', (path) => {
    delete process.env.FOO_TEST_KEY;
    delete process.env.BAR_TEST_KEY;
    loadEnv(path);
    assert.equal(process.env.FOO_TEST_KEY, 'hello');
    assert.equal(process.env.BAR_TEST_KEY, 'world');
    delete process.env.FOO_TEST_KEY;
    delete process.env.BAR_TEST_KEY;
  });
});

test('loadEnv leaves existing process.env values untouched', () => {
  withTempEnvFile('EXISTING_TEST_KEY=from-file\n', (path) => {
    process.env.EXISTING_TEST_KEY = 'from-shell';
    loadEnv(path);
    assert.equal(process.env.EXISTING_TEST_KEY, 'from-shell');
    delete process.env.EXISTING_TEST_KEY;
  });
});

test('loadEnv is a no-op when the file is missing', () => {
  assert.doesNotThrow(() => loadEnv('/nonexistent/path/.env.does-not-exist'));
});

test('loadEnv skips blank lines and comments', () => {
  withTempEnvFile('\n# a comment\nCOMMENT_TEST_KEY=value\n\n# trailing comment\n', (path) => {
    delete process.env.COMMENT_TEST_KEY;
    loadEnv(path);
    assert.equal(process.env.COMMENT_TEST_KEY, 'value');
    delete process.env.COMMENT_TEST_KEY;
  });
});

test('loadEnv handles values containing "=" and surrounding whitespace', () => {
  withTempEnvFile('EQUALS_TEST_KEY = a=b=c \n', (path) => {
    delete process.env.EQUALS_TEST_KEY;
    loadEnv(path);
    assert.equal(process.env.EQUALS_TEST_KEY, 'a=b=c');
    delete process.env.EQUALS_TEST_KEY;
  });
});
