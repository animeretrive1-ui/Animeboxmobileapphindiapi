/**
 * Cloudflare Worker — upstream relay for iqsmartgames.com APIs
 *
 * Whitelisted upstream hosts:
 *   - streams.iqsmartgames.com   (Step 1: slug API)
 *   - ssn.iqsmartgames.com       (Step 2: embed helper / embedhelper.php)
 *
 * The Worker replaces all request headers with a realistic Chrome browser
 * fingerprint. This is critical: forwarding the Node.js/Vercel headers
 * triggers Cloudflare's "Just a moment..." bot challenge on ssn.iqsmartgames.com.
 * Requests from a CF Worker to another CF-protected site travel within
 * Cloudflare's network and bypass the JS challenge — but only when the
 * headers look like a real browser.
 *
 * Routes:
 *   GET  /relay?url=<encoded>              — forward GET with browser headers
 *   POST /relay?url=<encoded>              — forward POST, body passed through
 *   GET  /health                           — liveness check
 */

const ALLOWED_HOSTS = new Set([
  'streams.iqsmartgames.com',
  'ssn.iqsmartgames.com',
]);

// These are stripped from the incoming request before relaying
const STRIP_INCOMING = new Set([
  'host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
  'cf-worker', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
]);

// Realistic Chrome 124 browser headers — used for ALL upstream requests.
// The Worker owns the outbound fingerprint; callers send metadata via
// custom x-relay-* headers instead (see extractor.js).
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function browserHeaders(referer, origin, extraHeaders = {}) {
  return {
    'User-Agent': CHROME_UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': referer,
    'Origin': origin,
    'Connection': 'keep-alive',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    ...extraHeaders,
  };
}

export default {
  async fetch(request, env, ctx) {
    const incoming = new URL(request.url);

    // ── CORS pre-flight ──────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ── Health check ─────────────────────────────────────────────────────────
    if (incoming.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    // ── Only handle /relay ───────────────────────────────────────────────────
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

    // ── Whitelist check ───────────────────────────────────────────────────────
    if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
      return new Response(`Host not allowed: ${targetUrl.hostname}`, { status: 403 });
    }

    // ── Build outbound headers ────────────────────────────────────────────────
    // Callers can pass x-relay-referer and x-relay-origin to control the
    // Referer/Origin values without exposing them in the URL.
    const callerReferer = request.headers.get('x-relay-referer');
    const callerOrigin  = request.headers.get('x-relay-origin');
    const isPost        = request.method === 'POST';

    // Derive sensible defaults if caller didn't specify
    const defaultOrigin  = `${targetUrl.protocol}//${targetUrl.host}`;
    const defaultReferer = `${defaultOrigin}/`;

    const outboundHeaders = browserHeaders(
      callerReferer || defaultReferer,
      callerOrigin  || defaultOrigin,
      isPost ? {
        'Content-Type': request.headers.get('content-type') || 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'sec-fetch-site': 'cross-site',  // POST to embedhelper is cross-site
      } : {}
    );

    // ── Proxy the request ─────────────────────────────────────────────────────
    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: outboundHeaders,
        body: isPost ? request.body : undefined,
        redirect: 'follow',
      });
    } catch (err) {
      return new Response(`Relay fetch failed: ${err.message}`, { status: 502 });
    }

    // ── Return upstream response ──────────────────────────────────────────────
    const responseHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders())) {
      responseHeaders.set(k, v);
    }
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
