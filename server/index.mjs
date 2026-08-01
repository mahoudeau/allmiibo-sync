// The admin service: a small HTTP server, node built-ins only.
//
// It serves the admin UI and a handful of JSON endpoints, and it writes two
// things: the curated overlay, and the regenerated database inside the public
// site. The public site itself is served by Apache and knows nothing about this
// process; if it dies, the site is unaffected.
//
// Configuration comes from the environment, never from the repository:
//
//   ADMIN_PASSWORD_HASH   from hashPassword() in auth.mjs
//   SESSION_SECRET        32+ bytes of hex
//   PUBLIC_SITE_DIR       where the public site's files live
//   DATA_DIR              where the overlay and its backups live
//   CACHE_DIR             the fetched upstream sources
//   PORT, HOST            listen address
//   INSECURE_COOKIES      set only for local http development
//
// The admin's hostname is deliberately absent: the UI uses relative URLs, so
// nothing here needs to know it, and it therefore cannot leak into the repo.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, normalize, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Store, BACKUP_NAME_RE } from './store.mjs';
import { Regenerator, GenerateError, publicReport } from './regen.mjs';
import { Upstream } from './upstream.mjs';
import {
  verifyPassword, issueSession, readSession, sessionCookie, clearCookie,
  readCookie, checkCsrf, RateLimiter, CSRF_HEADER,
} from './auth.mjs';
import { EMPTY_OVERLAY, serializeOverlay } from '../web/js/overlay.js';
import { diffDatabases, applyDecisions, undecided } from '../web/js/dbdiff.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UI_DIR = join(ROOT, 'admin');

// A save is a few hundred kB of JSON at the very most. Anything larger is a
// mistake or an attempt to exhaust memory, and is refused before being read.
const MAX_BODY = 4 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export function createAdminServer(config = {}) {
  const raw = {
    passwordHash: process.env.ADMIN_PASSWORD_HASH ?? '',
    sessionSecret: process.env.SESSION_SECRET ?? '',
    publicSiteDir: process.env.PUBLIC_SITE_DIR ?? join(ROOT, 'web'),
    dataDir: process.env.DATA_DIR ?? join(ROOT, 'content'),
    cacheDir: process.env.CACHE_DIR ?? join(ROOT, 'tools/.cache'),
    secureCookies: process.env.INSECURE_COOKIES !== '1',
    ...config,
  };

  // Every directory is resolved to an absolute path before anything uses it.
  // A relative one such as PUBLIC_SITE_DIR=./web breaks the containment check
  // below, because join() normalises "./web" + "/css/app.css" to "web/css/…",
  // which does not start with "./web" — so the server refuses its own files as
  // if they were a traversal attempt. Resolving up front removes the whole
  // class of mismatch rather than trying to compare two spellings of one path.
  const cfg = {
    ...raw,
    publicSiteDir: resolve(raw.publicSiteDir),
    dataDir: resolve(raw.dataDir),
    cacheDir: resolve(raw.cacheDir),
  };

  const store = new Store({
    overlayPath: join(cfg.dataDir, 'amiibo-overrides.json'),
    backupDir: join(cfg.dataDir, 'backups'),
  });
  const regen = new Regenerator({
    cacheDir: cfg.cacheDir,
    dbPath: join(cfg.publicSiteDir, 'data/amiibo-db.js'),
  });
  const upstream = new Upstream({
    cacheDir: cfg.cacheDir,
    ...(config.sources ? { sources: config.sources } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  const limiter = new RateLimiter();
  // Being a polite consumer of someone else's raw endpoint under a stuck retry
  // loop. Keyed by a constant rather than by client: the point is not to defend
  // against the single authenticated operator.
  const fetchLimiter = new RateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });

  // Refresh, preview and apply run one at a time. Not a rate limit — a mutex.
  // Two concurrent applies could interleave store.write and promote, which is
  // the one way to lose curated data here.
  let inFlight = null;
  const exclusive = async (fn) => {
    if (inFlight) return { busy: true };
    inFlight = (async () => fn())();
    try {
      return { busy: false, value: await inFlight };
    } finally {
      inFlight = null;
    }
  };

  const configured = Boolean(cfg.passwordHash && cfg.sessionSecret);

  const json = (res, status, body, headers = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      // Nothing here is cacheable, and an authenticated response certainly is
      // not shareable.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers,
    });
    res.end(text);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY) return reject(Object.assign(new Error('body too large'), { status: 413 }));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // Checked as it arrives too: content-length is a claim, not a promise.
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const clientKey = (req) => {
    // Behind a reverse proxy the socket address is the proxy, so the forwarded
    // address is preferred. It is spoofable by a direct client, which only
    // matters for rate limiting: an attacker can already vary their own key.
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
    return req.socket.remoteAddress ?? 'unknown';
  };

  const sessionOf = (req) =>
    readSession(readCookie(req.headers.cookie), cfg.sessionSecret);

  /**
   * Validate an overlay, write it, and rebuild the site from it.
   *
   * The single write path. A save and a restore are the same operation on a
   * different source of the overlay, and they must be held to the same gates —
   * a restore of a backup taken before an upstream change can fail to build
   * just as a fresh edit can. Sharing the code is the only way that stays true.
   *
   * The order matters and is the whole safety story: refuse before writing.
   *
   * @returns {{ status: number, body: object }}
   */
  async function publish(overlay) {
    // Checked before anything is written: a save that would put two amiibos on
    // one device path is refused, with the reason, and the overlay on disk is
    // untouched.
    const dry = await regen.dryRun(overlay ?? EMPTY_OVERLAY);
    if (!dry.ok) {
      return { status: 422, body: { error: 'the database would not build', details: dry.errors } };
    }

    let saved;
    try {
      saved = await store.write(overlay);
    } catch (err) {
      return { status: 422, body: { error: err.message, details: err.details ?? [] } };
    }

    try {
      const built = await regen.run(overlay);
      return {
        status: 200,
        body: {
          ok: true,
          backup: saved.backup,
          bytes: built.bytes,
          entries: built.report.entries,
          authored: built.report.authored.length,
          notices: built.report.notices,
        },
      };
    } catch (err) {
      // The overlay is saved but the site was not rebuilt. Say so plainly
      // rather than reporting a success that did not fully happen.
      const details = err instanceof GenerateError ? err.details : [err.message];
      return { status: 500, body: { error: 'saved, but the site was not rebuilt', details } };
    }
  }

  /**
   * A fingerprint of everything the preview was computed from.
   *
   * Apply sends it back. If it no longer matches, the world moved underneath —
   * a second tab saved, someone re-fetched, `npm run update-db` ran on the box
   * — and the decisions describe a diff that no longer exists. That is a
   * refusal, not something to reconcile.
   */
  const fingerprint = (dbText, pendingMeta, overlay) =>
    createHash('sha256')
      .update(dbText)
      .update(JSON.stringify(pendingMeta?.sources ?? []))
      .update(serializeOverlay(overlay))
      .digest('hex');

  /**
   * What a pending refresh would change, without writing anything.
   *
   * The candidate is built from pending/ while the live cache is left alone,
   * which is what makes this safe to call at any time.
   */
  async function buildPreview() {
    const meta = await upstream.pending();
    if (!meta) return { status: 200, body: { pending: null } };

    const overlay = await store.read();
    const dry = await regen.dryRun(overlay, { cacheDir: upstream.pendingDir });
    if (!dry.ok) {
      // The new sources introduce something the build refuses — a collision,
      // usually. There is no candidate to diff against, and inventing a
      // degraded one would be a second code path exercised once a year.
      return {
        status: 200,
        body: {
          pending: meta,
          ok: false,
          errors: dry.errors,
          diff: null,
          fingerprint: null,
        },
      };
    }

    const diff = diffDatabases(dry.previous, dry.contents, { overlay });
    return {
      status: 200,
      body: {
        pending: meta,
        ok: true,
        errors: [],
        diff,
        report: publicReport(dry.report),
        fingerprint: fingerprint(dry.previous, meta, overlay),
      },
    };
  }

  /**
   * Decide a pending refresh and publish the result.
   *
   * The order is the whole safety story, and one part of it is worth stating
   * because it looks wrong: the cache is promoted BEFORE the database is
   * written. If the rebuild then fails, the cache is new and the database is
   * old, and any retry regenerates the same reviewed result. The other order
   * would leave the database ahead of the cache, so the next ordinary save
   * would silently REVERT published data to the old upstream. Reverting is the
   * worse failure.
   */
  async function applyUpstream({ fingerprint: sent, decisions = {} }) {
    const meta = await upstream.pending();
    if (!meta) return { status: 409, body: { error: 'there is no pending refresh to apply' } };

    const overlay = await store.read();
    const dry = await regen.dryRun(overlay, { cacheDir: upstream.pendingDir });
    if (!dry.ok) {
      return { status: 422, body: { error: 'the refresh would not build', details: dry.errors } };
    }

    const current = fingerprint(dry.previous, meta, overlay);
    if (sent !== current) {
      return {
        status: 409,
        body: { error: 'the preview is out of date', fingerprint: current },
      };
    }

    // The diff is re-derived here rather than trusted from the client: the
    // decisions are allowed to NAME changes, never to describe them.
    const diff = diffDatabases(dry.previous, dry.contents, { overlay });

    // Anything the client did not name is accepted. Refusing instead used to
    // mean a row nobody could act on — a brand new series label with a single
    // possible answer — held the whole update hostage. Accepting by default is
    // also what the site does the rest of the time: it follows upstream unless
    // the overlay says otherwise. The count is reported back so the receipt
    // says how much was taken without being asked about.
    const byDefault = diff.changes
      .filter((c) => !decisions[c.key])
      .map((c) => c.key);
    const settled = { ...Object.fromEntries(byDefault.map((k) => [k, 'keep'])), ...decisions };

    const today = new Date().toISOString().slice(0, 10);
    const { overlay: next, applied } = applyDecisions(overlay, diff, settled, today);
    applied.acceptedByDefault = byDefault.length;

    // Refuse before writing, exactly as a save does: a decision set that would
    // collide two amiibo onto one device path is rejected with the reason and
    // nothing is touched.
    const check = await regen.dryRun(next, { cacheDir: upstream.pendingDir });
    if (!check.ok) {
      return {
        status: 422,
        body: { error: 'those decisions would not build', details: check.errors },
      };
    }

    let saved;
    try {
      saved = await store.write(next);
    } catch (err) {
      return { status: 422, body: { error: err.message, details: err.details ?? [] } };
    }

    await upstream.promote();

    try {
      // The bytes `check` produced are exactly the bytes to write: the overlay
      // and the sources are the same, so building again would only cost time.
      const built = await regen.writeContents(check.contents);
      const renames = diff.changes
        .filter((c) => c.group === 'naming' && settled[c.key] !== 'skip' && c.device)
        .map((c) => ({ before: c.device.before, after: c.device.after }));
      return {
        status: 200,
        body: {
          ok: true,
          backup: saved.backup,
          bytes: built.bytes,
          entries: check.report.entries,
          applied,
          renames,
          report: publicReport(check.report),
        },
      };
    } catch (err) {
      const details = err instanceof GenerateError ? err.details : [err.message];
      return {
        status: 500,
        body: { error: 'applied, but the site was not rebuilt', details },
      };
    } finally {
      await upstream.discard();
    }
  }

  /** A download. The filename is always a validated constant or a matched name. */
  function attachment(res, text, filename) {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(text);
  }

  async function serveUi(req, res, pathname) {
    // The admin reuses the site's stylesheet, fonts and shared modules rather
    // than keeping second copies that could drift: the same skin, the same
    // mascot, the same icons. These prefixes resolve into the public site;
    // everything else is the admin's own UI.
    const shared = pathname.startsWith('/css/')
      || pathname.startsWith('/fonts/')
      || pathname.startsWith('/js/')
      // The whole data directory, not only the artwork. The admin draws the
      // collection grid, which means it imports /js/amiibo.js, which imports
      // ../data/amiibo-db.js — the browser resolves that to /data/amiibo-db.js.
      // Routing only /data/images/ here served the pictures and 404'd the
      // database, and a module whose import 404s never runs at all: the page
      // stayed on the sign-in form with the boot notice showing.
      || pathname.startsWith('/data/');
    const root = shared ? cfg.publicSiteDir : UI_DIR;

    // The path is normalised and then checked to be inside its root: this is
    // the one place a request string touches the filesystem.
    const rel = pathname === '/' ? '/index.html' : pathname;
    const full = normalize(join(root, rel));
    if (!full.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(full).catch(() => null);
    const target = info?.isDirectory() ? join(full, 'index.html') : full;
    const body = await readFile(target).catch(() => null);
    if (body === null) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // The admin must never be indexed, framed, or leak its URL onward.
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;

      if (!configured) {
        return json(res, 503, {
          error: 'not configured',
          detail: 'ADMIN_PASSWORD_HASH and SESSION_SECRET must be set in the environment.',
        });
      }

      // ---- login ----------------------------------------------------------
      if (path === '/api/login' && req.method === 'POST') {
        const key = clientKey(req);
        limiter.sweep();
        const gate = limiter.check(key);
        if (gate.locked) {
          return json(res, 429, {
            error: 'too many attempts',
            retryAfterSeconds: Math.ceil(gate.retryAfterMs / 1000),
          }, { 'retry-after': String(Math.ceil(gate.retryAfterMs / 1000)) });
        }

        let password = '';
        try {
          password = JSON.parse(await readBody(req))?.password ?? '';
        } catch { /* falls through to the failure below */ }

        if (!verifyPassword(password, cfg.passwordHash)) {
          limiter.fail(key);
          // Deliberately vague: no hint about whether anything was close.
          return json(res, 401, { error: 'wrong password' });
        }
        limiter.succeed(key);
        const { token, csrf } = issueSession(cfg.sessionSecret);
        return json(res, 200, { ok: true, csrf },
          { 'set-cookie': sessionCookie(token, { secure: cfg.secureCookies }) });
      }

      if (path === '/api/logout' && req.method === 'POST') {
        return json(res, 200, { ok: true },
          { 'set-cookie': clearCookie({ secure: cfg.secureCookies }) });
      }

      // ---- everything past here needs a session ---------------------------
      if (path.startsWith('/api/')) {
        const session = sessionOf(req);
        if (!session) return json(res, 401, { error: 'not signed in' });

        const mutating = req.method !== 'GET' && req.method !== 'HEAD';
        if (mutating && !checkCsrf(session, req.headers[CSRF_HEADER])) {
          return json(res, 403, { error: 'missing or bad CSRF token' });
        }

        if (path === '/api/session' && req.method === 'GET') {
          return json(res, 200, { ok: true, csrf: session.csrf, expires: session.exp });
        }

        if (path === '/api/db' && req.method === 'GET') {
          // The generated database, as data. Imported fresh each time with a
          // cache-busting query, because it is rewritten on every save and the
          // module cache would otherwise serve the version from startup.
          const dbUrl = `${pathToFileURL(join(cfg.publicSiteDir, 'data/amiibo-db.js')).href}?v=${Date.now()}`;
          const db = await import(dbUrl).catch(() => null);
          if (!db) return json(res, 503, { error: 'the site database has not been built yet' });
          return json(res, 200, {
            names: db.AMIIBO_NAMES,
            series: db.AMIIBO_SERIES,
            types: db.AMIIBO_TYPES,
            release: db.AMIIBO_RELEASE,
            seriesShort: db.AMIIBO_SERIES_SHORT,
            fileNames: db.AMIIBO_FILE_NAMES,
            shortNames: db.AMIIBO_SHORT_NAMES,
            categories: db.AMIIBO_CATEGORIES,
            paths: db.AMIIBO_PATHS,
            notes: db.AMIIBO_NOTES,
            authored: db.AMIIBO_AUTHORED,
            upstream: db.AMIIBO_UPSTREAM,
          });
        }

        if (path === '/api/overlay' && req.method === 'GET') {
          return json(res, 200, {
            overlay: await store.read(),
            modified: await store.modified(),
            upstreamReady: await regen.ready(),
          });
        }

        if (path === '/api/overlay' && req.method === 'PUT') {
          let overlay;
          try {
            overlay = JSON.parse(await readBody(req));
          } catch (err) {
            return json(res, err.status ?? 400, { error: err.message || 'invalid JSON' });
          }
          const { status, body } = await publish(overlay);
          return json(res, status, body);
        }

        if (path === '/api/backups' && req.method === 'GET') {
          return json(res, 200, { backups: await store.backups() });
        }

        // One backup, verbatim. The route captures a single segment and the
        // name is then checked against the store's own pattern — imported
        // rather than restated, because two copies of a filename whitelist
        // drifting apart is how a traversal gets in. Nothing touches the
        // filesystem until it passes, and the filename in the header is the
        // validated name, never the raw request.
        const backupMatch = path.match(/^\/api\/backups\/([^/]+)$/);
        if (backupMatch && req.method === 'GET') {
          const name = backupMatch[1];
          if (!BACKUP_NAME_RE.test(name)) return json(res, 400, { error: 'not a backup name' });
          const text = await store.readBackupRaw(name).catch(() => null);
          if (text === null) return json(res, 404, { error: 'no such backup' });
          return attachment(res, text, name);
        }

        // Restore runs the identical gates as a save, because it is one: the
        // overlay it writes came from this machine but could still fail to
        // build if the sources have moved on since it was taken.
        if (path === '/api/restore' && req.method === 'POST') {
          let name;
          try {
            ({ name } = JSON.parse(await readBody(req)) ?? {});
          } catch (err) {
            return json(res, err.status ?? 400, { error: err.message || 'invalid JSON' });
          }
          let overlay;
          try {
            overlay = await store.readBackup(name);
          } catch {
            return json(res, 404, { error: 'no such backup' });
          }
          const { status, body } = await publish(overlay);
          // store.write backed the current overlay up first, so this is itself
          // undoable — worth saying rather than leaving to be discovered.
          return json(res, status, { ...body, restored: name });
        }

        if (path === '/api/export' && req.method === 'GET') {
          return attachment(res, await store.readRaw(), 'amiibo-overrides.json');
        }

        // ---- upstream ------------------------------------------------------

        if (path === '/api/upstream' && req.method === 'GET') {
          const status = await upstream.status();
          return json(res, 200, { ...status, promotedAt: await upstream.promotedAt() });
        }

        if (path === '/api/upstream/refresh' && req.method === 'POST') {
          const gate = fetchLimiter.check('upstream');
          if (gate.locked) {
            res.setHeader('retry-after', Math.ceil(gate.retryAfterMs / 1000));
            return json(res, 429, {
              error: 'too many refreshes in the last hour',
              retryAfterSeconds: Math.ceil(gate.retryAfterMs / 1000),
            });
          }
          const { busy, value } = await exclusive(async () => {
            fetchLimiter.fail('upstream');
            try {
              return { ok: true, meta: await upstream.refresh() };
            } catch (err) {
              return { ok: false, error: err.message };
            }
          });
          if (busy) return json(res, 409, { error: 'a refresh is already running' });
          // Nothing was written on failure — not even to pending.
          return value.ok
            ? json(res, 200, { ok: true, ...value.meta })
            : json(res, 502, { error: 'the upstream sources could not be fetched', details: [value.error] });
        }

        if (path === '/api/upstream/pending' && req.method === 'DELETE') {
          await upstream.discard();
          return json(res, 200, { ok: true });
        }

        if (path === '/api/upstream/preview' && req.method === 'GET') {
          const { busy, value } = await exclusive(() => buildPreview());
          if (busy) return json(res, 409, { error: 'a refresh is already running' });
          return json(res, value.status, value.body);
        }

        if (path === '/api/upstream/apply' && req.method === 'POST') {
          let body;
          try {
            body = JSON.parse(await readBody(req)) ?? {};
          } catch (err) {
            return json(res, err.status ?? 400, { error: err.message || 'invalid JSON' });
          }
          const { busy, value } = await exclusive(() => applyUpstream(body));
          if (busy) return json(res, 409, { error: 'a refresh is already running' });
          return json(res, value.status, value.body);
        }

        return json(res, 404, { error: 'no such endpoint' });
      }

      // ---- the UI ---------------------------------------------------------
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: 'method not allowed' });
      }
      return serveUi(req, res, path);
    } catch (err) {
      // Never leak a stack trace to the client; log it instead.
      console.error('admin error:', err);
      if (!res.headersSent) json(res, err.status ?? 500, { error: 'server error' });
      else res.end();
    }
  });

  return { server, store, regen, config: cfg };
}

// ---- CLI ----------------------------------------------------------------

const isCli = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  const port = Number(process.env.PORT ?? 8081);
  const host = process.env.HOST ?? '127.0.0.1';
  const { server, config } = createAdminServer();
  if (!config.passwordHash || !config.sessionSecret) {
    console.error('ADMIN_PASSWORD_HASH and SESSION_SECRET must be set. Refusing to start unprotected.');
    console.error("Generate a hash with:  node -e \"import('./server/auth.mjs').then(m=>console.log(m.hashPassword('your password')))\"");
    process.exit(1);
  }
  server.listen(port, host, () => {
    console.log(`admin listening on http://${host}:${port}/`);
    console.log(`  public site: ${config.publicSiteDir}`);
    console.log(`  data:        ${config.dataDir}`);
  });
}
