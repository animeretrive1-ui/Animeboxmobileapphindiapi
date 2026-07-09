require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');

// Configuration
const CONFIG = {
    mySeriesApiKey: process.env.MY_SERIES_API_KEY || '', // REQUIRED: User must provide this
    tmdbApiKey: process.env.TMDB_API_KEY || '', // Optional: For fetching episode names
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
};

/**
 * Helper to fetch episode name from TMDB if key is available
 */
async function getEpisodeName(tmdbId, season, episode) {
    if (!CONFIG.tmdbApiKey) {
        // console.log('No TMDB API Key provided, using default episode name.');
        return `Episode ${episode}`;
    }
    try {
        const url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}/episode/${episode}?api_key=${CONFIG.tmdbApiKey}`;
        const res = await axios.get(url);
        return res.data.name || `Episode ${episode}`;
    } catch (e) {
        console.warn('Failed to fetch episode name from TMDB:', e.message);
        return `Episode ${episode}`;
    }
}

/**
 * Step 1: Get File Slug from MySeriesAPI
 */
async function getFileSlug(tmdbId, season, epName) {
    if (!CONFIG.mySeriesApiKey) {
        throw new Error('MY_SERIES_API_KEY is missing. Please set it in .env or config.');
    }

    const baseUrl = 'https://streams.iqsmartgames.com/myseriesapi';
    const params = new URLSearchParams({
        tmdb: tmdbId,
        season: season,
        epname: epName,
        key: CONFIG.mySeriesApiKey
    });

    const url = `${baseUrl}?${params.toString()}`;
    console.log(`[Step 1] Fetching metadata from: ${url}`);

    try {
        const response = await axios.get(url, { headers: { 'User-Agent': CONFIG.userAgent } });
        const data = response.data;
        
        if (data.fileslug) return data.fileslug;
        if (data.data && data.data.fileslug) return data.data.fileslug;
        
        // Handle "filename" format if returned directly
        // User example: {"filename":..., "fileslug":"k5bko76"}
        if (data.fileslug) return data.fileslug;

        throw new Error('File slug not found in response');
    } catch (error) {
        console.error('[Step 1] Error:', error.message);
        throw error;
    }
}

/**
 * Step 1.5: Visit the file page to get Cookies and Tokens
 * (Skipped as it appears unnecessary for embedhelper based on tests)
 */
async function getPageContext(fileSlug) {
    // Return minimal context required for Referer
    return { 
        cookieHeader: '', 
        viewToken: '', 
        referer: `https://pro.iqsmartgames.com/` 
    };
}

/**
 * Step 2: Get Embed Data from EmbedHelper
 */
async function getEmbedData(fileSlug, context) {
    const url = 'https://ssn.iqsmartgames.com/embedhelper.php';
    console.log(`[Step 2] Posting to ${url} with slug: ${fileSlug}`);

    // Simulate domain logic
    const referrerDomain = 'pro.iqsmartgames.com';
    const currentDomain = 'pro.iqsmartgames.com';
    const embedderDomainJson = JSON.stringify([referrerDomain, currentDomain]);

    const params = new URLSearchParams();
    params.append('sid', fileSlug);
    params.append('UserFavSite', '');
    params.append('currentDomain', embedderDomainJson);

    try {
        const response = await axios.post(url, params, {
            headers: {
                'User-Agent': CONFIG.userAgent,
                'Referer': context.referer,
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
    } catch (error) {
        console.error('[Step 2] Error:', error.message);
        if (error.response && error.response.status === 400) {
            console.error('       Server returned 400 Bad Request. Payload verification required.');
        }
        throw error;
    }
}

const urlSuffixesEmbed = {
    "plrx": "/",
    "stmrb": ".html",
    "strmtp": "/",
    "dpld": "?srv10.dropload.io/i/01/00118/uv0mx9c9xicj",
};

/**
 * Step 3: Decode and Extract Links
 */
function processEmbedData(data) {
    console.log('[Step 3] Processing embed data...');
    
    const { mresult, siteUrls, siteFriendlyNames } = data;
    
    // Decode mresult (Base64)
    let decodedMresult;
    try {
        const buffer = Buffer.from(mresult, 'base64');
        decodedMresult = JSON.parse(buffer.toString('utf-8'));
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
            const fullUrl = `${baseUrl}${id}${suffix}`;
            results.push({
                provider: name,
                id: id,
                url: fullUrl
            });
        }
    }

    return results;
}

async function main() {
    const tmdbId = process.argv[2];
    const season = process.argv[3];
    const episode = process.argv[4];
    const manualEpName = process.argv[5];

    if (!tmdbId || !season || !episode) {
        console.log('Usage: node stream_extractor.js <tmdbId> <season> <episode> [epname]');
        console.log('Example: node stream_extractor.js 61663 1 1 "Monotone Colorful"');
        return;
    }

    try {
        const epName = manualEpName || await getEpisodeName(tmdbId, season, episode);
        console.log(`Target: TMDB:${tmdbId} S${season}E${episode} "${epName}"`);

        let fileSlug;
        if (CONFIG.mySeriesApiKey) {
            fileSlug = await getFileSlug(tmdbId, season, epName);
        } else {
            console.log('\n[WARN] MY_SERIES_API_KEY not set.');
            // Fallback for demo/testing if user provides parameters matching the example
            if (tmdbId === '61663' && season === '1' && episode === '1') {
                console.log('Using demo slug "k5bko76" for testing...');
                fileSlug = 'k5bko76';
            } else {
                // Check if user provided slug as arg? No, let's stick to error.
                throw new Error('MY_SERIES_API_KEY is missing. Cannot fetch slug.');
            }
        }

        console.log(`File Slug: ${fileSlug}`);

        // Get Context (Cookies/Tokens)
        const context = await getPageContext(fileSlug);
        
        // Get Embed Data
        const embedData = await getEmbedData(fileSlug, context);
        
        // Process
        const streams = processEmbedData(embedData);

        console.log('\n=== Stream Links ===');
        streams.forEach(s => {
            console.log(`[${s.provider}] ${s.url}`);
        });

    } catch (error) {
        console.error('Main Error:', error.message);
    }
}

main();
