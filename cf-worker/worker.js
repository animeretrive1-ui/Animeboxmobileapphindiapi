/**
 * Cloudflare Worker — upstream relay for streams.iqsmartgames.com
 *
 * Allowed upstream hosts (whitelist prevents open-proxy abuse):
 *   - streams.iqsmartgames.com   (Step 1: slug API)
 *   - ssn.iqsmartgames.com       (Step 2: embed helper)
 *
 * Usage from your Vercel function:
 *   GET  https://<worker>.workers.dev/relay?url=<encoded-upstream-url>
 *   POST https://<worker>.workers.dev/relay?url=<encoded-upstream-url>
 *        body + Content-Type are forwarded as-is.
 *
 * All original request headers sent by the caller are forwarded, so
 * extractor.js keeps full control over User-Agent, Referer, etc.
 *
 * Deploy:
 *   1. npx wrangler deploy  (from the cf-worker/ directory)
 *      — OR —
 *   1. Paste this file into https://workers.cloudflare.com/ > Quick Edit
 *   2. Save & Deploy
 *   3. Copy the *.workers.dev URL and set it as RELAY_URL in Vercel env vars.
 */

const ALLOWED_HOSTS = new Set([
  'streams.iqsmartgames.com',
  'ssn.iqsmartgames.com',
]);

// Headers the browser / caller sends that CF Workers must not forward verbatim
const HOP_BY_HOP = new Set([
  'host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
  'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
  'connection', 'keep-alive', 'transfer-encoding', 'te',
  'trailer', 'upgrade',
]);

export default {
  async fetch(request, env, ctx) {
    const incoming = new URL(request.url);

    // ---------- CORS pre-flight ----------
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // ---------- Only handle /relay ----------
    if (incoming.pathname !== '/relay') {
      return new Response('Not found', { status: 404 });
    }

    const rawTarget = incoming.searchParams.get('url');
    if (!rawTarget) {
      return new Response('Missing ?url= parameter', { status: 400 });
    }

    let targetUrl;
    try {
      targetUrl = new URL(decodeURIComponent(rawTarget));
    } catch {
      return new Response('Invalid URL', { status: 400 });
    }

    // ---------- Whitelist check ----------
    if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
      return new Response(`Host not allowed: ${targetUrl.hostname}`, { status: 403 });
    }

    // ---------- Forward headers (strip hop-by-hop + CF internals) ----------
    const forwardHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) {
        forwardHeaders.set(key, value);
      }
    }

    // ---------- Proxy the request ----------
    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: forwardHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'follow',
      });
    } catch (err) {
      return new Response(`Relay fetch failed: ${err.message}`, { status: 502 });
    }

    // ---------- Return upstream response with CORS headers ----------
    const responseHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders())) {
      responseHeaders.set(k, v);
    }
    // Remove CF-added headers that could confuse callers
    responseHeaders.delete('cf-cache-status');
    responseHeaders.delete('cf-ray');

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}
