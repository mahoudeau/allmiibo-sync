// The CLI entry points must run their CLI block when invoked as `node <file>`.
//
// This exists because of a bug no other test could see. The guard was
//     import.meta.url === `file://${process.argv[1]}`
// which only matches on POSIX. On Windows argv[1] is `C:\dir\file.mjs`, so the
// template yields `file://C:\dir\file.mjs` — two slashes and backslashes —
// while import.meta.url is `file:///C:/dir/file.mjs`. Never equal, so the CLI
// block was skipped and the script exited 0 having done nothing:
//
//   npm run update-db      fetched nothing, regenerated nothing
//   npm run fetch-images   fetched nothing
//   npm run admin          served nothing
//
// Exiting 0 is what made it dangerous rather than obvious — a caller cannot
// tell it apart from success. So these assert on a CLI that says what it needs,
// which is the smallest observable proof that the block ran at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const cli = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

/** Run a CLI and return { code, stdout, stderr } without throwing on failure. */
async function runCli(file, { env = {} } = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli(file)], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('build-amiibo-db explains its arguments rather than exiting silently', async () => {
  const { code, stderr } = await runCli('tools/build-amiibo-db.mjs');
  assert.equal(code, 1, 'a CLI with no arguments exits 1, not 0');
  assert.match(stderr, /usage: node tools\/build-amiibo-db\.mjs/);
});

test('the admin server refuses to start unconfigured rather than exiting silently', async () => {
  // Blanked explicitly, so a developer's real .env cannot make this pass by
  // accident: the assertion is that the CLI block ran and made a decision.
  const { code, stderr } = await runCli('server/index.mjs', {
    env: { ADMIN_PASSWORD_HASH: '', SESSION_SECRET: '' },
  });
  assert.equal(code, 1, 'an unconfigured server exits 1, not 0');
  assert.match(stderr, /ADMIN_PASSWORD_HASH and SESSION_SECRET must be set/);
});
