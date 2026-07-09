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
// HTTP client — undici with HTTP/2 + realistic TLS/ALPN to avoid bot blocks
// on Vercel datacenter IPs. Falls back to node-fetch-compatible fetch if
// undici is unavailable.
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
                // Do NOT set rejectUnauthorized:false — that's a bot fingerprint.
                // Let Node use its default CA bundle instead.
                ALPNProtocols: ['h2', 'http/1.1'],
                // Mimic a Chrome TLS session more closely
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
        console.warn('[extractor] undici not available, will use global fetch');
    }
    return _agent;
}

/**
 * Fetch wrapper that uses undici's HTTP/2-capable dispatcher when available.
 * Throws on network error; returns the Response object otherwise (callers
 * check .status themselves).
 */
async function h2Fetch(url, options = {}) {
    const agent = getAgent();
    if (agent) {
        const { fetch: undiciFetch } = require('undici');
        return undiciFetch(url, { ...options, dispatcher: agent });
    }
    // Fallback: use the global fetch (Node 18+)
    return fetch(url, options);
}

// ---------------------------------------------------------------------------
// Shared browser-like headers that reduce bot-detection probability
// ---------------------------------------------------------------------------

/**
 * Build the request headers that mimic a Chrome browser making a same-site
 * XHR from the iqsmartgames.com embed page.
 */
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
        // same-site because Origin and Referer share the same eTLD+1
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

/**
 * Step 1: Get File Slug from the iqsmartgames API.
 * - For series: calls /myseriesapi with tmdbid, season, epname (episode number)
 * - For movies: calls /mymovieapi with tmdbid
 * Retries once with an alternative User-Agent on 403.
 */
async function getFileSlug(tmdbId, season, episode, type = 'series', userAgent) {
    let url;
    let referer;

    if (type === 'movie') {
        url = `${API_BASE}/mymovieapi?tmdbid=${tmdbId}&key=${API_KEY}`;
        referer = `${API_BASE}/embed/movie/${tmdbId}?key=${API_KEY}`;
    } else {
        url = `${API_BASE}/myseriesapi?tmdbid=${tmdbId}&season=${season}&epname=${episode}&key=${API_KEY}`;
        referer = `${API_BASE}/embed/tv/${tmdbId}/${season}/${episode}?key=${API_KEY}`;
    }

    console.log(`[Step 1] Fetching slug from: ${url}`);

    const attemptFetch = async (ua) => {
        return h2Fetch(url, {
            method: 'GET',
            headers: buildApiHeaders(referer, ua),
        });
    };

    let response = await attemptFetch(userAgent || CONFIG.userAgent);

    // On 403, retry once with the fallback UA (different OS/Chrome version)
    if (response.status === 403) {
        console.warn('[Step 1] Got 403, retrying with fallback UA...');
        const fallbackUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
        response = await attemptFetch(fallbackUA);
    }

    if (response.status !== 200) {
        const body = await response.text().catch(() => '');
        throw new Error(`API returned status ${response.status}${body ? ': ' + body.slice(0, 120) : ''}`);
    }

    const data = await response.json();

    // Handle array response: [{fileslug, filename, ...}, ...]
    if (Array.isArray(data.data) && data.data.length > 0 && data.data[0].fileslug) {
        return data.data[0].fileslug;
    }
    // Handle object response: {data: {fileslug: ...}}
    if (data.data && data.data.fileslug) {
        return data.data.fileslug;
    }
    // Handle flat response: {fileslug: ...}
    if (data.fileslug) {
        return data.fileslug;
    }

    throw new Error(`File slug not found in API response. Response: ${JSON.stringify(data).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Step 2: Get embed data
// ---------------------------------------------------------------------------

/**
 * Step 2: Post the file slug to embedhelper to get stream sources.
 */
async function getEmbedData(fileSlug, userAgent) {
    const url = 'https://ssn.iqsmartgames.com/embedhelper.php';
    const ua = userAgent || CONFIG.userAgent;

    const embedderDomainJson = JSON.stringify(['pro.iqsmartgames.com', 'pro.iqsmartgames.com']);

    const params = new URLSearchParams();
    params.append('sid', fileSlug);
    params.append('UserFavSite', '');
    params.append('currentDomain', embedderDomainJson);

    console.log(`[Step 2] Fetching embed data for slug: ${fileSlug}`);

    const headers = {
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
    };

    let response = await h2Fetch(url, {
        method: 'POST',
        headers,
        body: params.toString(),
    });

    // Retry once on 403
    if (response.status === 403) {
        console.warn('[Step 2] Got 403, retrying...');
        await new Promise(r => setTimeout(r, 800)); // small back-off
        response = await h2Fetch(url, {
            method: 'POST',
            headers: {
                ...headers,
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
            body: params.toString(),
        });
    }

    if (response.status !== 200) {
        throw new Error(`Embed helper returned status ${response.status}`);
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

/**
 * Unwrap URLs proxied through the technocosmos.surf HLS player wrapper.
 * e.g. "https://plyr.technocosmos.surf/hlsplayer?url=https://multimovies.rpmhub.site/#abc123"
 *   -> "https://multimovies.rpmhub.site/#abc123"
 */
function unwrapProxyUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.hostname === 'plyr.technocosmos.surf' && parsed.searchParams.has('url')) {
            const innerUrl = parsed.searchParams.get('url');
            const hash = parsed.hash; // e.g. '#xajpyc'
            return innerUrl + hash;
        }
    } catch (e) {
        // not a valid URL, return as-is
    }
    return rawUrl;
}

// ---------------------------------------------------------------------------
// Step 3: Decode the base64 mresult and build stream URL list
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
            const fullUrl = unwrapProxyUrl(rawUrl);
            results.push({ provider: name, id, url: fullUrl });
        }
    }

    return results;
}

module.exports = {
    getFileSlug,
    getEmbedData,
    processEmbedData
};
