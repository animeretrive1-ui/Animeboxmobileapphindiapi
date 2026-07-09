const axios = require('axios');

// Configuration
const CONFIG = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

const API_KEY = 'e11a7debaaa4f5d25b671706ffe4d2acb56efbd4';
const API_BASE = 'https://streams.iqsmartgames.com';

const urlSuffixesEmbed = {
    "plrx": "/",
    "stmrb": ".html",
    "strmtp": "/",
};

/**
 * Step 1: Get File Slug from the iqsmartgames API.
 * - For series: calls /myseriesapi with tmdbid, season, epname (episode number)
 * - For movies: calls /mymovieapi with tmdbid
 * No fallback mapping. Passes exact values received.
 */
async function getFileSlug(tmdbId, season, episode, type = 'series') {
    let url;

    if (type === 'movie') {
        url = `${API_BASE}/mymovieapi?tmdbid=${tmdbId}&key=${API_KEY}`;
    } else {
        url = `${API_BASE}/myseriesapi?tmdbid=${tmdbId}&season=${season}&epname=${episode}&key=${API_KEY}`;
    }

    console.log(`[Step 1] Fetching slug from: ${url}`);

    const response = await axios.get(url, {
        headers: {
            'User-Agent': CONFIG.userAgent,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': `${API_BASE}/`,
            'Origin': API_BASE
        },
        validateStatus: status => status < 500
    });

    if (response.status !== 200) {
        throw new Error(`API returned status ${response.status}`);
    }

    const data = response.data;

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

/**
 * Step 2: Post the file slug to embedhelper to get stream sources.
 */
async function getEmbedData(fileSlug) {
    const url = 'https://ssn.iqsmartgames.com/embedhelper.php';

    const embedderDomainJson = JSON.stringify(['pro.iqsmartgames.com', 'pro.iqsmartgames.com']);

    const params = new URLSearchParams();
    params.append('sid', fileSlug);
    params.append('UserFavSite', '');
    params.append('currentDomain', embedderDomainJson);

    console.log(`[Step 2] Fetching embed data for slug: ${fileSlug}`);

    const response = await axios.post(url, params, {
        headers: {
            'User-Agent': CONFIG.userAgent,
            'Referer': 'https://pro.iqsmartgames.com/',
            'Origin': 'https://pro.iqsmartgames.com',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest'
        }
    });

    const data = response.data;

    if (!data.mresult) {
        throw new Error('No mresult in embed response');
    }

    return data;
}

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

/**
 * Step 3: Decode the base64 mresult and build stream URL list.
 */
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
