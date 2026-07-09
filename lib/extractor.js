// Configuration
const CONFIG = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

const API_KEY = 'e11a7debaaa4f5d25b671706ffe4d2acb56efbd4';
const API_BASE = 'https://streams.iqsmartgames.com';

const urlSuffixesEmbed = {
    "plrx": "/",
    "stmrb": ".html",
    "strmtp": "/",
};

// ---------------------------------------------------------------------------
// Relay routing
//
// On Vercel the outbound IPs are datacenter ranges that streams.iqsmartgames.com
// and ssn.iqsmartgames.com block with 403.  Setting the RELAY_URL environment
// variable (e.g. https://multimovieapi-relay.<you>.workers.dev) makes every
// upstream call go through the Cloudflare Worker relay instead.
//
// Locally RELAY_URL is unset so requests go direct — no change to dev workflow.
// ---------------------------------------------------------------------------

/**
 * Wrap an upstream URL so it is fetched via the CF Worker relay when
 * RELAY_URL is configured, or returned unchanged for direct calls.
 */
function relayUrl(upstreamUrl) {
    const relay = process.env.RELAY_URL;
    if (!relay) return upstreamUrl;
    // Strip trailing slash from relay base, then append /relay?url=...
    return `${relay.replace(/\/$/, '')}/relay?url=${encodeURIComponent(upstreamUrl)}`;
}

// ---------------------------------------------------------------------------
// HTTP client — undici with HTTP/2 + realistic TLS/ALPN.
// When going through the CF Worker relay the TLS fingerprint is Cloudflare's
// own (trusted), so the cipher/ALPN config still helps for direct calls.
// ---------------------------------------------------------------------------

let _agent = null;

function getAgent() {
    if (_agent) return _agent;
    try {
        const { Agent } = require('undici');
        _agent = new Agent({
            allowH2: true,
            keepAliveTimeout: 20_000,
            keepAliveMaxTimeout: 60_000,
            connect: {
                ALPNProtocols: ['h2', 'http/1.1'],
                ciphers: [
                    'TLS_AES_128_GCM_SHA256',
                    'TLS_AES_256_GCM_SHA384',
                    'TLS_CHACHA20_POLY1305_SHA256',
                    'ECDHE-ECDSA-AES128-GCM-SHA256',
                    'ECDHE-RSA-AES128-GCM-SHA256',
                    'ECDHE-ECDSA-AES256-GCM-SHA384',
                    'ECDHE-RSA-AES256-GCM-SHA384',
                ].join(':'),
            }
        });
    } catch (e) {
        console.warn('[extractor] undici not available, falling back to global fetch');
    }
    return _agent;
}

async function h2Fetch(url, options = {}) {
    const agent = getAgent();
    if (agent) {
        const { fetch: undiciFetch } = require('undici');
        return undiciFetch(url, { ...options, dispatcher: agent });
    }
    return fetch(url, options);
}

// ---------------------------------------------------------------------------
// Shared browser-like headers
// ---------------------------------------------------------------------------

function buildApiHeaders(referer, userAgent) {
    const ua = userAgent || CONFIG.userAgent;
    return {
        'User-Agent': ua,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': referer,
        'Origin': API_BASE,
        'Connection': 'keep-alive',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
    };
}

// ---------------------------------------------------------------------------
// Step 1: Get file slug
// ---------------------------------------------------------------------------

async function getFileSlug(tmdbId, season, episode, type = 'series', userAgent) {
    let directUrl;
    let referer;

    if (type === 'movie') {
        directUrl = `${API_BASE}/mymovieapi?tmdbid=${tmdbId}&key=${API_KEY}`;
        referer = `${API_BASE}/embed/movie/${tmdbId}?key=${API_KEY}`;
    } else {
        directUrl = `${API_BASE}/myseriesapi?tmdbid=${tmdbId}&season=${season}&epname=${episode}&key=${API_KEY}`;
        referer = `${API_BASE}/embed/tv/${tmdbId}/${season}/${episode}?key=${API_KEY}`;
    }

    const fetchUrl = relayUrl(directUrl);
    const usingRelay = fetchUrl !== directUrl;
    console.log(`[Step 1] Fetching slug${usingRelay ? ' via relay' : ''}: ${directUrl}`);

    const attemptFetch = (ua) => h2Fetch(fetchUrl, {
        method: 'GET',
        headers: {
            ...buildApiHeaders(referer, ua),
            // Relay-side header overrides — Worker uses these to set correct
            // Referer/Origin on the outbound request to the upstream API.
            'x-relay-referer': referer,
            'x-relay-origin': API_BASE,
        },
    });

    let response = await attemptFetch(userAgent || CONFIG.userAgent);

    // On 403 without relay — retry with alternate UA (last-resort header tweak)
    if (response.status === 403 && !usingRelay) {
        console.warn('[Step 1] Got 403 on direct call, retrying with fallback UA...');
        const fallbackUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
        response = await attemptFetch(fallbackUA);
    }

    if (response.status !== 200) {
        const body = await response.text().catch(() => '');
        throw new Error(`API returned status ${response.status}${body ? ': ' + body.slice(0, 200) : ''}`);
    }

    const data = await response.json();

    if (Array.isArray(data.data) && data.data.length > 0 && data.data[0].fileslug) {
        return data.data[0].fileslug;
    }
    if (data.data && data.data.fileslug) {
        return data.data.fileslug;
    }
    if (data.fileslug) {
        return data.fileslug;
    }

    throw new Error(`File slug not found in API response. Response: ${JSON.stringify(data).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Step 2: Get embed data
// ---------------------------------------------------------------------------

async function getEmbedData(fileSlug, userAgent) {
    const directUrl = 'https://ssn.iqsmartgames.com/embedhelper.php';
    const ua = userAgent || CONFIG.userAgent;

    const fetchUrl = relayUrl(directUrl);
    const usingRelay = fetchUrl !== directUrl;
    console.log(`[Step 2] Fetching embed data${usingRelay ? ' via relay' : ''} for slug: ${fileSlug}`);

    const embedderDomainJson = JSON.stringify(['pro.iqsmartgames.com', 'pro.iqsmartgames.com']);
    const params = new URLSearchParams();
    params.append('sid', fileSlug);
    params.append('UserFavSite', '');
    params.append('currentDomain', embedderDomainJson);

    const buildHeaders = (ua) => ({
        'User-Agent': ua,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://pro.iqsmartgames.com/',
        'Origin': 'https://pro.iqsmartgames.com',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Connection': 'keep-alive',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
    });

    const attemptPost = (ua) => h2Fetch(fetchUrl, {
        method: 'POST',
        headers: {
            ...buildHeaders(ua),
            // Relay-side header overrides for embedhelper.php
            'x-relay-referer': 'https://pro.iqsmartgames.com/',
            'x-relay-origin': 'https://pro.iqsmartgames.com',
        },
        body: params.toString(),
    });

    let response = await attemptPost(ua);

    // On 403 without relay — retry with different UA + small back-off
    if (response.status === 403 && !usingRelay) {
        console.warn('[Step 2] Got 403 on direct call, retrying with fallback UA...');
        await new Promise(r => setTimeout(r, 800));
        response = await attemptPost(
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );
    }

    if (response.status !== 200) {
        const body = await response.text().catch(() => '');
        throw new Error(`Embed helper returned status ${response.status}${body ? ': ' + body.slice(0, 200) : ''}`);
    }

    const data = await response.json();

    if (!data.mresult) {
        throw new Error('No mresult in embed response');
    }

    return data;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function unwrapProxyUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.hostname === 'plyr.technocosmos.surf' && parsed.searchParams.has('url')) {
            return parsed.searchParams.get('url') + parsed.hash;
        }
    } catch (e) { /* not a valid URL */ }
    return rawUrl;
}

// ---------------------------------------------------------------------------
// Step 3: Decode mresult and build stream list
// ---------------------------------------------------------------------------

function processEmbedData(data) {
    const { mresult, siteUrls, siteFriendlyNames } = data;

    let decodedMresult;
    try {
        decodedMresult = JSON.parse(Buffer.from(mresult, 'base64').toString('utf-8'));
    } catch (e) {
        console.error('Failed to decode mresult:', e.message);
        return [];
    }

    const results = [];
    for (const [key, id] of Object.entries(decodedMresult)) {
        const name = (siteFriendlyNames && siteFriendlyNames[key]) ? siteFriendlyNames[key] : key;
        const baseUrl = (siteUrls && siteUrls[key]) ? siteUrls[key] : '';
        const suffix = urlSuffixesEmbed[key] || '';

        if (baseUrl) {
            const rawUrl = `${baseUrl}${id}${suffix}`;
            results.push({ provider: name, id, url: unwrapProxyUrl(rawUrl) });
        }
    }

    return results;
}

module.exports = {
    getFileSlug,
    getEmbedData,
    processEmbedData
};
