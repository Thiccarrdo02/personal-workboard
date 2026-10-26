// ZAWISH Workboard — Cloudflare Worker.
// Static files in public/ are served by Workers Static Assets before this code
// runs; this Worker only answers /api/* (and sends due digests every 15 minutes).

import { HttpError, json, readJson } from './http.js';
import { authenticate, bearerToken, checkSetupLink, completeSetup, listProfiles, login, revokeSession } from './auth.js';
import { getBoard, saveBoard } from './board.js';
import { listTeam, pendingCount, requestAccess, requestStatus, requireOwner, teamAction } from './team.js';
import {
  activateBot, createLink, disconnect, getNotifications, handleWebhook, notifyOwner, requestPing,
  saveNotifications, sendDueDigests, sendTestDigest
} from './telegram.js';
import { deleteAccount, exportData, listDevices, signOutOtherDevices } from './me.js';

// Tests pass env.NOW to control the clock.
function clock(env) {
  return typeof env.NOW === 'function' ? env.NOW() : Date.now();
}

// Runs a task after the response is sent (e.g. Telegram pings), never failing the request.
function later(ctx, promise) {
  const guarded = promise.catch(err => console.warn('Background task failed:', err.message));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(guarded);
}

async function requireSession(env, request, body = null) {
  // navigator.sendBeacon can't set headers, so a token in the body is accepted too.
  const token = bearerToken(request) || (body && typeof body.token === 'string' ? body.token : null);
  const session = await authenticate(env, token, clock(env));
  if (!session) throw new HttpError(401, 'Signed out. Please enter your PIN again.');
  return session;
}

async function route(request, env, ctx, url) {
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
    if (body.action !== 'complete') return json(await checkSetupLink(env, request, body, now));
    const result = await completeSetup(env, request, body, now);
    if (result.purpose === 'setup' && result.user.role !== 'owner') {
      later(ctx, notifyOwner(env, `🎉 ${result.user.name} joined ZAWISH Workboard using your invite.`));
    }
    return json(result);
  }

  if (pathname === '/api/request' && method === 'POST') {
    const result = await requestAccess(env, request, await readJson(request), now);
    const ping = requestPing(result.user, result.note);
    later(ctx, notifyOwner(env, ping.text, ping.extra));
    return json(result);
  }

  if (pathname === '/api/request' && method === 'GET') {
    return json(await requestStatus(env, bearerToken(request), now));
  }

  if (pathname === '/api/team' && method === 'GET') {
    const session = await requireSession(env, request);
    requireOwner(session);
    return json(await listTeam(env, now));
  }

  if (pathname === '/api/team' && method === 'POST') {
    const body = await readJson(request);
    const session = await requireSession(env, request);
    requireOwner(session);
    return json(await teamAction(env, session, body, now));
  }

  if (pathname === '/api/me' && method === 'GET') {
    const session = await requireSession(env, request);
    return json({ ok: true, user: session.user });
  }

  if (pathname === '/api/me/export' && method === 'GET') {
    const session = await requireSession(env, request);
    return json(await exportData(env, session, now));
  }

  if (pathname === '/api/me/devices' && method === 'GET') {
    const session = await requireSession(env, request);
    return json(await listDevices(env, session));
  }

  if (pathname === '/api/me/devices' && method === 'POST') {
    const session = await requireSession(env, request);
    return json(await signOutOtherDevices(env, session));
  }

  if (pathname === '/api/me/delete' && method === 'POST') {
    const body = await readJson(request);
    const session = await requireSession(env, request);
    const result = await deleteAccount(env, request, session, body, now);
    later(ctx, notifyOwner(env, `👋 ${result.name} deleted their ZAWISH Workboard account. Their board was removed.`));
    return json(result);
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const session = await requireSession(env, request);
    await revokeSession(env, session.tokenHash);
    return json({ ok: true });
  }

  if (pathname === '/api/sync' && method === 'GET') {
    const session = await requireSession(env, request);
    const result = await getBoard(env, session.user.id, url.searchParams.get('rev'));
    // The owner's app shows a badge when someone is waiting to join.
    if (session.user.role === 'owner') result.teamPending = await pendingCount(env);
    return json(result);
  }

  if (pathname === '/api/sync' && method === 'POST') {
    const body = await readJson(request);
    const session = await requireSession(env, request, body);
    return json(await saveBoard(env, session.user.id, body, now));
  }

  if (pathname === '/api/notifications' && method === 'GET') {
    const session = await requireSession(env, request);
    return json(await getNotifications(env, session.user));
  }

  if (pathname === '/api/notifications' && method === 'POST') {
    const body = await readJson(request);
    const session = await requireSession(env, request);
    switch (body.action) {
      case 'save': return json(await saveNotifications(env, session.user, body));
      case 'link': return json(await createLink(env, session.user, body, now));
      case 'disconnect': return json(await disconnect(env, session.user));
      case 'test': return json(await sendTestDigest(env, session.user, now));
      case 'activate':
        requireOwner(session);
        return json(await activateBot(env, url.origin));
      default: throw new HttpError(400, 'Unknown action.');
    }
  }

  // Telegram calls this for every message / button press (checked by secret header).
  if (pathname === '/api/telegram' && method === 'POST') {
    return json(await handleWebhook(env, request, now));
  }

  throw new HttpError(404, 'Not found.');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, ctx, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ ok: false, error: err.message, ...err.extra }, err.status);
      console.error('API error:', err);
      return json({ ok: false, error: 'Something went wrong on the server.' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDueDigests(env, clock(env)));
  }
};
