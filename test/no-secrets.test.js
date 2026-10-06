// Guards: the browser bundle never references the key, and if a real key is
// present in the environment, no tracked source file contains it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    if (['node_modules', '.git', '.vercel'].includes(f) || f.startsWith('.env')) return [];
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test('client-side code never touches the Qloo key or API host', () => {
  for (const f of files(join(root, 'public'))) {
    const s = readFileSync(f, 'utf8');
    assert.ok(!/QLOO_API_KEY|X-Api-Key|api\.qloo\.com/i.test(s), `${f} must not reference Qloo credentials or call Qloo directly`);
  }
});

test('no source file contains the real key value', { skip: !process.env.QLOO_API_KEY }, () => {
  const key = process.env.QLOO_API_KEY;
  for (const f of files(root)) assert.ok(!readFileSync(f, 'utf8').includes(key), `secret found in ${f}`);
});

test('local cache folders and env files are ignored by git and Vercel', () => {
  const gi = readFileSync(join(root, '.gitignore'), 'utf8');
  for (const p of ['.env', '.cache/', '.vercel']) assert.ok(gi.includes(p), `.gitignore must cover ${p}`);
  const vi = readFileSync(join(root, '.vercelignore'), 'utf8');
  assert.ok(vi.includes('.cache'), '.vercelignore must cover .cache');
});
