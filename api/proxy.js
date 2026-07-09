const axios = require('axios');

module.exports = async (req, res) => {
    const { url, referer } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Accept-Encoding');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Cache-Control');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        // Helpers
        const safeDecode = (value) => {
            if (!value) return value;
            try { return decodeURIComponent(value); } catch { return value; }
        };
        const sanitize = (value) => {
            if (!value) return value;
            return value.trim().replace(/^`+|`+$/g, '').replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
        };
        const decodeRepeatedly = (value) => {
            let current = value;
            for (let i = 0; i < 3; i++) {
                const decoded = safeDecode(current);
                if (!decoded || decoded === current) return decoded;
                current = decoded;
            }
            return current;
        };

        let decodedUrl = sanitize(decodeRepeatedly(url));
        let decodedRefererRaw = sanitize(decodeRepeatedly(referer));
        
        if (decodedUrl && decodedUrl.startsWith('//')) {
            decodedUrl = `https:${decodedUrl}`;
        }
        if (!decodedUrl) {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        let parsedUrl;
        try { parsedUrl = new URL(decodedUrl); } catch { return res.status(400).json({ error: 'Invalid URL format' }); }

        let decodedReferer = decodedRefererRaw || `${parsedUrl.origin}/`;
        let derivedOrigin = parsedUrl.origin;
        try { derivedOrigin = new URL(decodedReferer).origin; } catch {}

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': decodedReferer,
            'Accept': '*/*',
        };

        // Special handling for zephyrflick
        if (parsedUrl.hostname.endsWith('play.zephyrflick.top')) {
            decodedReferer = 'https://play.zephyrflick.top/';
            headers['Referer'] = decodedReferer;
        } else {
            headers['Origin'] = derivedOrigin;
        }

        if (req.headers['range']) {
            headers['Range'] = req.headers['range'];
        }

        const response = await axios({
            method: 'GET',
            url: decodedUrl,
            headers: headers,
            responseType: 'arraybuffer',
            validateStatus: (status) => status < 500,
            timeout: 30000,
        });

        const contentType = response.headers['content-type'] || 'application/vnd.apple.mpegurl';
        res.setHeader('Content-Type', contentType);

        if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
        if (response.headers['content-range']) res.setHeader('Content-Range', response.headers['content-range']);
        
        const acceptRanges = response.headers['accept-ranges'];
        res.setHeader('Accept-Ranges', acceptRanges || 'bytes');

        if (decodedUrl.endsWith('.ts') || decodedUrl.endsWith('.m4s')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (decodedUrl.endsWith('.m3u8')) {
            res.setHeader('Cache-Control', 'no-cache');
        }

        // Rewriting Logic for m3u8
        if (contentType.includes('mpegurl') || decodedUrl.endsWith('.m3u8')) {
            const content = Buffer.from(response.data).toString('utf-8');
            const basePath = decodedUrl.substring(0, decodedUrl.lastIndexOf('/') + 1);
            const forwardedProto = req.headers['x-forwarded-proto'];
            const baseUrl = `${forwardedProto || 'https'}://${req.headers.host}`;

            const resolveUrl = (inputUrl) => {
                if (!inputUrl) return inputUrl;
                try {
                    const resolved = new URL(inputUrl, decodedUrl);
                    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return inputUrl;
                    return resolved.toString();
                } catch { return inputUrl; }
            };

            const toProxyUrl = (inputUrl) => {
                const resolved = resolveUrl(inputUrl);
                if (!resolved || (!resolved.startsWith('http://') && !resolved.startsWith('https://'))) return inputUrl;
                const encodedUrl = encodeURIComponent(resolved);
                const encodedReferer = encodeURIComponent(decodedReferer);
                return `${baseUrl}/api/proxy?url=${encodedUrl}&referer=${encodedReferer}`;
            };

            const lines = content.split('\n');
            const newLines = lines.map(line => {
                line = line.trim();
                if (!line) return line;
                if (line.startsWith('#')) {
                    // Rewrite URI="..." in tags like #EXT-X-KEY
                    return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${toProxyUrl(uri)}"`)
                               .replace(/URI=([^",\s]+)/g, (_, uri) => `URI=${toProxyUrl(uri)}`);
                }
                // Rewrite segment URLs
                let targetUrl = line;
                if (!line.startsWith('http')) {
                    targetUrl = basePath + line;
                }
                return toProxyUrl(targetUrl);
            });

            return res.status(response.status).send(newLines.join('\n'));
        }

        // Proxy binary/other content directly
        if (response.status === 206 || response.headers['content-range']) {
            res.status(206);
        } else {
            res.status(response.status);
        }

        return res.send(Buffer.from(response.data));

    } catch (error) {
        console.error('Proxy error:', error.message);
        if (error.response) {
            return res.status(error.response.status).send(`Upstream error: ${error.response.status}`);
        }
        return res.status(500).send(`Proxy error: ${error.message}`);
    }
};
