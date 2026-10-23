// ZAWISH Workboard — Cloudflare Worker.
// Static files in public/ are served by Workers Static Assets before this code
// runs; this Worker only answers /api/* (and runs the daily digest cron).

import { HttpError, json, readJson } from './http.js';
import { authenticate, bearerToken, checkSetupLink, completeSetup, listProfiles, login, revokeSession } from './auth.js';
import { getBoard, saveBoard } from './board.js';
import { handleDigest, sendScheduledDigest } from './digest.js';

// Tests pass env.NOW to control the clock.
function clock(env) {
  return typeof env.NOW === 'function' ? env.NOW() : Date.now();
}

async function requireSession(env, request, body = null) {
  // navigator.sendBeacon can't set headers, so a token in the body is accepted too.
  const token = bearerToken(request) || (body && typeof body.token === 'string' ? body.token : null);
  const session = await authenticate(env, token, clock(env));
  if (!session) throw new HttpError(401, 'Signed out. Please enter your PIN again.');
  return session;
}

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;
  const now = clock(env);

  if (pathname === '/api/profiles' && method === 'GET') {
    return json({ ok: true, profiles: await listProfiles(env) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    return json(await login(env, request, await readJson(request), now));
  }

  if (pathname === '/api/setup' && method === 'POST') {
    const body = await readJson(request);
    return json(body.action === 'complete'
      ? await completeSetup(env, request, body, now)
      : await checkSetupLink(env, request, body, now));
  }

  if (pathname === '/api/me' && method === 'GET') {
    const session = await requireSession(env, request);
    return json({ ok: true, user: session.user });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const session = await requireSession(env, request);
    await revokeSession(env, session.tokenHash);
    return json({ ok: true });
  }

  if (pathname === '/api/sync' && method === 'GET') {
    const session = await requireSession(env, request);
    return json(await getBoard(env, session.user.id, url.searchParams.get('rev')));
  }

  if (pathname === '/api/sync' && method === 'POST') {
    const body = await readJson(request);
    const session = await requireSession(env, request, body);
    return json(await saveBoard(env, session.user.id, body, now));
  }

  if (pathname === '/api/digest' && (method === 'GET' || method === 'POST')) {
    const body = method === 'POST' ? await readJson(request) : {};
    const session = await requireSession(env, request);
    return json(await handleDigest(env, session.user, body.action || url.searchParams.get('action') || 'status', now));
  }

  throw new HttpError(404, 'Not found.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ ok: false, error: err.message, ...err.extra }, err.status);
      console.error('API error:', err);
      return json({ ok: false, error: 'Something went wrong on the server.' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendScheduledDigest(env, clock(env)));
  }
};
