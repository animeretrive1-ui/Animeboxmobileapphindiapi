const { getFileSlug, getEmbedData, processEmbedData } = require('../lib/extractor');
const { extractUniversal } = require('../lib/universal_extractor');

module.exports = async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { tmdbId, season, episode, type } = req.query;

    // Validate required params
    if (!tmdbId) {
        return res.status(400).json({ error: 'Missing required parameter: tmdbId' });
    }

    const isMovie = type === 'movie';

    if (!isMovie && (!season || !episode)) {
        return res.status(400).json({
            error: 'Missing required parameters for series: season and episode are required'
        });
    }

    try {
        const userAgent = req.headers['user-agent'];

        // Step 1: Get file slug from iqsmartgames API (no fallbacks, exact values passed)
        const fileSlug = await getFileSlug(tmdbId, season, episode, isMovie ? 'movie' : 'series', userAgent);

        // Step 2: Get embed data
        const embedData = await getEmbedData(fileSlug, userAgent);

        // Step 3: Process embed data into stream list
        const streams = processEmbedData(embedData);

        // Step 4: Extract HLS from each stream URL in parallel
        const enrichedStreams = await Promise.all(
            streams.map(async (stream) => {
                try {
                    const hlsData = await extractUniversal(stream.url);
                    if (hlsData) {
                        const protocol = req.headers['x-forwarded-proto'] || 'https';
                        const host = req.headers.host;
                        const proxyBaseUrl = `${protocol}://${host}/api/proxy`;

                        const proxyUrl = `${proxyBaseUrl}?url=${encodeURIComponent(hlsData.streamUrl)}&referer=${encodeURIComponent(hlsData.headers.Referer || stream.url)}`;

                        const resultStream = {
                            ...stream,
                            hls: hlsData.streamUrl,
                            headers: hlsData.headers
                        };

                        if (req.query.phls !== undefined) {
                            resultStream.phls = proxyUrl;
                        }

                        return resultStream;
                    }
                } catch (err) {
                    console.error(`HLS extraction failed for ${stream.url}:`, err.message);
                }
                return stream;
            })
        );

        return res.status(200).json({
            meta: {
                tmdbId,
                type: isMovie ? 'movie' : 'series',
                season: isMovie ? undefined : season,
                episode: isMovie ? undefined : episode,
                slug: fileSlug
            },
            streams: enrichedStreams
        });

    } catch (error) {
        console.error('API Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};
