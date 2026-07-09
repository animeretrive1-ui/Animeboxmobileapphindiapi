const crypto = require('crypto');

// ---------------------------------------------------------------------------
// HTTP/2-capable fetch — reuses the same agent from extractor.js so we only
// create one undici Agent per process.
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
        console.warn('[universal_extractor] undici unavailable, falling back to global fetch');
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
// User-Agent pool — rotate on retries to vary the fingerprint
// ---------------------------------------------------------------------------

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function getRandomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Build browser-like GET headers for a given origin/referer pair.
 */
function browserHeaders(ua, referer, origin) {
    return {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': referer || '',
        'Origin': origin || '',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'cross-site',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
    };
}

/**
 * Build browser-like XHR/fetch headers (for API sub-requests).
 */
function xhrHeaders(ua, referer, origin) {
    return {
        'User-Agent': ua,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': referer || '',
        'Origin': origin || '',
        'Connection': 'keep-alive',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeHtml(html) {
    if (!html) return '';
    return html
        .replace(/\\u002F/g, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&')
        .replace(/\\u0026/g, '&');
}

// ---------------------------------------------------------------------------
// UPNS Extractor
// ---------------------------------------------------------------------------

const UPNS_KEY_HEX = '6b69656d7469656e6d75613931316361';

function unpadPKCS7(paddedData) {
    if (!paddedData || paddedData.length === 0) return Buffer.alloc(0);
    const padValue = paddedData[paddedData.length - 1];
    if (padValue < 1 || padValue > 16) return paddedData;
    for (let i = paddedData.length - padValue; i < paddedData.length; i++) {
        if (paddedData[i] !== padValue) return paddedData;
    }
    return paddedData.slice(0, paddedData.length - padValue);
}

function decryptUpns(encryptedHexStr, keyHex) {
    try {
        const keyBytes = Buffer.from(keyHex, 'hex');
        const fullPayloadBytes = Buffer.from(encryptedHexStr.trim(), 'hex');
        if (fullPayloadBytes.length < 16) throw new Error('Encrypted data too short');
        const iv = fullPayloadBytes.slice(0, 16);
        const ciphertext = fullPayloadBytes.slice(16);
        const decipher = crypto.createDecipheriv('aes-128-cbc', keyBytes, iv);
        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return unpadPKCS7(decrypted).toString('utf-8');
    } catch (error) {
        console.error('UPNS Decryption error:', error.message);
        return null;
    }
}

async function extractFromUpns(playerUrl) {
    try {
        const ua = getRandomUA();
        const urlObj = new URL(playerUrl);
        const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
        const referer = `${baseUrl}/`;

        // Determine video ID from hash, query params, or path
        let videoId = null;
        const hashMatch = playerUrl.match(/#([a-zA-Z0-9]+)$/);
        if (hashMatch) {
            videoId = hashMatch[1];
        } else {
            videoId = urlObj.searchParams.get('id')
                   || urlObj.searchParams.get('video')
                   || urlObj.searchParams.get('v');
        }
        if (!videoId) {
            const pathMatch = playerUrl.match(/\/([a-zA-Z0-9]{5,})(?:\/|$|#)/);
            if (pathMatch) videoId = pathMatch[1];
        }
        if (!videoId) return null;

        const apiUrl = `${baseUrl}/api/v1/video?id=${videoId}&w=1920&h=1200&r=`;
        const apiResponse = await h2Fetch(apiUrl, {
            headers: xhrHeaders(ua, referer, baseUrl),
        });

        if (!apiResponse.ok) {
            console.warn(`[UPNS] API responded ${apiResponse.status}`);
            return null;
        }

        const responseText = await apiResponse.text();
        const decryptedText = decryptUpns(responseText, UPNS_KEY_HEX);
        if (!decryptedText) return null;

        const sourceMatch = decryptedText.match(/"source"\s*:\s*"([^"]+)"/);
        if (!sourceMatch) return null;

        let streamUrl = sourceMatch[1].replace(/\\\//g, '/');
        if (streamUrl && !streamUrl.startsWith('http')) {
            streamUrl = new URL(streamUrl, baseUrl).toString();
        }

        return { streamUrl, headers: { 'User-Agent': ua, 'Referer': referer, 'Origin': baseUrl } };
    } catch (e) {
        console.error('UPNS Error:', e.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// STRMUP Extractor
// ---------------------------------------------------------------------------

function decodePrintable95(encodedHexString, shift) {
    if (!encodedHexString) return '';
    try {
        const intermediateString = Buffer.from(encodedHexString, 'hex').toString('latin1');
        const decodedChars = [];
        for (let index = 0; index < intermediateString.length; index++) {
            const charCode = intermediateString.charCodeAt(index);
            const s = charCode - 32;
            const i = ((s - shift - index) % 95 + 95) % 95; // keep positive
            decodedChars.push(String.fromCharCode(i + 32));
        }
        return decodedChars.join('');
    } catch (error) {
        return '';
    }
}

async function extractFromStrmup(playerUrl) {
    try {
        const ua = getRandomUA();
        const urlObj = new URL(playerUrl);
        const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
        const referer = `${baseUrl}/`;

        const pageResponse = await h2Fetch(playerUrl, {
            headers: browserHeaders(ua, referer, baseUrl),
        });

        if (!pageResponse.ok) {
            console.warn(`[Strmup] Page responded ${pageResponse.status}`);
            return null;
        }

        const pageContent = await pageResponse.text();
        let streamUrl = null;

        if (pageContent.includes('decodePrintable95')) {
            const encodedMatch = pageContent.match(/decodePrintable95\("([a-f0-9]+)"/);
            const shiftMatch = pageContent.match(/__enc_shift\s*=\s*(\d+)/);
            if (encodedMatch && shiftMatch) {
                streamUrl = decodePrintable95(encodedMatch[1], parseInt(shiftMatch[1]));
            }
        }

        if (!streamUrl) {
            const mediaId = playerUrl.split('/').pop();
            const sUrl = `${baseUrl}/ajax/stream?filecode=${mediaId}`;
            try {
                const sResponse = await h2Fetch(sUrl, {
                    headers: xhrHeaders(ua, referer, baseUrl),
                });
                if (sResponse.ok) {
                    const sData = await sResponse.json();
                    if (sData && sData.streaming_url) streamUrl = sData.streaming_url;
                }
            } catch (e) { /* ignore */ }
        }

        if (streamUrl) {
            return { streamUrl, headers: { 'User-Agent': ua, 'Referer': referer, 'Origin': baseUrl } };
        }
        return null;
    } catch (e) {
        console.error('Strmup Error:', e.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// BSYE Extractor
// ---------------------------------------------------------------------------

function ft(e) {
    const t = e.replace(/-/g, '+').replace(/_/g, '/');
    const r = t.length % 4 === 0 ? 0 : 4 - (t.length % 4);
    return Buffer.from(t + '='.repeat(r), 'base64');
}
function xn(e) { return Buffer.concat(e.map(part => ft(part))); }

async function extractFromBsye(url) {
    try {
        const match = url.match(/\/(?:e|d)\/([0-9a-zA-Z]+)/);
        if (!match) return null;
        const mediaId = match[1];
        const parsedUrl = new URL(url);
        const host = parsedUrl.host;
        const origin = `https://${host}`;
        const ua = getRandomUA();

        const apiUrl = `${origin}/api/videos/${mediaId}/embed/playback`;
        const response = await h2Fetch(apiUrl, {
            headers: {
                ...xhrHeaders(ua, url, origin),
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
            },
        });

        if (!response.ok) {
            console.warn(`[BSYE] API responded ${response.status}`);
            return null;
        }

        const responseData = await response.json();
        let sources = responseData?.sources;

        if (!sources && responseData?.playback) {
            try {
                const pd = responseData.playback;
                const iv = ft(pd.iv);
                const key = xn(pd.key_parts);
                const payload = ft(pd.payload);
                const tagLength = 16;
                const ciphertext = payload.subarray(0, payload.length - tagLength);
                const tag = payload.subarray(payload.length - tagLength);
                const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
                decipher.setAuthTag(tag);
                let decrypted = decipher.update(ciphertext);
                decrypted = Buffer.concat([decrypted, decipher.final()]);
                sources = JSON.parse(decrypted.toString('utf8')).sources;
            } catch (e) { /* decryption failed */ }
        }

        if (sources && sources.length > 0) {
            const hlsSource = sources.find(s => (s.file || s.url || s.src || '').includes('.m3u8')) || sources[0];
            const fileUrl = hlsSource.file || hlsSource.url || hlsSource.src;
            if (fileUrl) {
                return { streamUrl: fileUrl, headers: { 'User-Agent': ua, 'Referer': `${origin}/`, 'Origin': origin } };
            }
        }
        return null;
    } catch (e) {
        console.error('BSYE Error:', e.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// SWISH / eval-packer Extractor
// ---------------------------------------------------------------------------

function unpack(packed) {
    try {
        const argsStart = packed.indexOf("}('");
        if (argsStart === -1) return null;
        const splitIndex = packed.lastIndexOf(".split('|')");
        if (splitIndex === -1) return null;
        const argsBody = packed.substring(argsStart + 2, splitIndex);
        const separatorRegex = /',(\d+),(\d+),'/g;
        let lastMatch = null;
        let match;
        while ((match = separatorRegex.exec(argsBody)) !== null) { lastMatch = match; }
        if (!lastMatch) return null;
        const radix = parseInt(lastMatch[1]);
        const count = parseInt(lastMatch[2]);
        const payload = argsBody.substring(0, lastMatch.index);
        const keywordsStr = argsBody.substring(lastMatch.index + lastMatch[0].length, argsBody.length - 1);
        const keywords = keywordsStr.split('|');
        const decode = (c) => (c < radix ? '' : decode(parseInt(c / radix))) + ((c = c % radix) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
        let unpacked = payload;
        for (let i = count - 1; i >= 0; i--) {
            if (keywords[i]) {
                unpacked = unpacked.replace(new RegExp('\\b' + decode(i) + '\\b', 'g'), keywords[i]);
            }
        }
        return unpacked;
    } catch (e) { return null; }
}

async function extractFromSwish(playerUrl) {
    try {
        const ua = getRandomUA();
        const urlObj = new URL(playerUrl);
        const origin = `${urlObj.protocol}//${urlObj.host}`;

        const response = await h2Fetch(playerUrl, {
            headers: browserHeaders(ua, `${origin}/`, origin),
        });

        if (!response.ok) {
            console.warn(`[Swish] Page responded ${response.status}`);
            return null;
        }

        const html = await response.text();
        let streamUrl = null;

        const packedMatch = html.match(/eval\(function\(p,a,c,k,e,d\).*?\.split\('\|'\)\)\)/s);
        if (packedMatch) {
            const unpacked = unpack(packedMatch[0]);
            if (unpacked) {
                const m3u8Match = unpacked.match(/https?:\/\/[^"']+\.m3u8[^"']*/);
                if (m3u8Match) streamUrl = m3u8Match[0];
            }
        }
        if (!streamUrl) {
            const m3u8Match = html.match(/https?:\/\/[^"']+\.m3u8[^"']*/);
            if (m3u8Match) streamUrl = m3u8Match[0];
        }

        if (streamUrl) {
            return { streamUrl: streamUrl.replace(/\\/g, ''), headers: { 'User-Agent': ua, 'Referer': playerUrl, 'Origin': origin } };
        }
        return null;
    } catch (e) {
        console.error('Swish Error:', e.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Generic / ASCDN Extractor
// ---------------------------------------------------------------------------

async function extractFromAsCdn(playerUrl) {
    try {
        const ua = getRandomUA();
        const urlObj = new URL(playerUrl);
        const origin = `${urlObj.protocol}//${urlObj.host}`;

        const response = await h2Fetch(playerUrl, {
            headers: browserHeaders(ua, `${origin}/`, origin),
        });

        if (!response.ok) {
            console.warn(`[Generic] Page responded ${response.status}`);
            return null;
        }

        const html = normalizeHtml(await response.text());
        const match = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/);
        if (match) {
            return { streamUrl: match[1], headers: { 'User-Agent': ua, 'Referer': playerUrl } };
        }
        return null;
    } catch (e) {
        console.error('Generic Error:', e.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

async function extractUniversal(playerUrl) {
    if (!playerUrl) return null;

    try {
        const urlObj = new URL(playerUrl);
        const hostname = urlObj.hostname;

        if (
            hostname.includes('uns.bio') ||
            hostname.includes('upns.one') ||
            hostname.includes('rpmhub.site') ||
            hostname.includes('p2pplay.pro')
        ) {
            console.log(`[Universal] Using UPNS extractor for ${hostname}`);
            return await extractFromUpns(playerUrl);
        }

        if (hostname.includes('strmup') || hostname.includes('streamup')) {
            console.log(`[Universal] Using Strmup extractor for ${hostname}`);
            return await extractFromStrmup(playerUrl);
        }

        if (
            hostname.includes('multimoviesshg.com') ||
            hostname.includes('hanerix.com') ||
            hostname.includes('smoothpre.com')
        ) {
            console.log(`[Universal] Using Swish extractor for ${hostname}`);
            const result = await extractFromSwish(playerUrl);
            if (result) return result;
        }

        if (playerUrl.includes('/e/') || playerUrl.includes('/d/')) {
            console.log(`[Universal] Using BSYE extractor for ${hostname}`);
            const result = await extractFromBsye(playerUrl);
            if (result) return result;
        }

        console.log(`[Universal] Using Generic extractor for ${hostname}`);
        return await extractFromAsCdn(playerUrl);

    } catch (error) {
        console.error(`[Universal] Error extracting from ${playerUrl}:`, error.message);
        return null;
    }
}

module.exports = { extractUniversal };
