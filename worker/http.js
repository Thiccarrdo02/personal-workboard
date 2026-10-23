// Small HTTP helpers shared by the Worker routes.

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export async function readJson(request, limit = 2_000_000) {
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, 'Request is too large.');
  if (!text) return {};
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' ? body : {};
  } catch (e) {
    throw new HttpError(400, 'Invalid JSON body.');
  }
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'local';
}

export function minutes(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return m === 1 ? '1 minute' : `${m} minutes`;
}
