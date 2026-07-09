const axios = require('axios');
const crypto = require('crypto');

// --- Helpers ---

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function normalizeHtml(html) {
    if (!html) return '';
    return html
        .replace(/\\u002F/g, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&')
        .replace(/\\u0026/g, '&');
}

// --- UPNS Extractor Logic ---
const UPNS_KEY_HEX = "6b69656d7469656e6d75613931316361";

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
        let decryptedPadded = decipher.update(ciphertext);
        decryptedPadded = Buffer.concat([decryptedPadded, decipher.final()]);
        
        const decryptedBytes = unpadPKCS7(decryptedPadded);
        return decryptedBytes.toString('utf-8');
    } catch (error) {
        console.error('UPNS Decryption error:', error.message);
        return null;
    }
}

async function extractFromUpns(playerUrl) {
    try {
        const userAgent = getRandomUserAgent();
        const urlObj = new URL(playerUrl);
        const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
        const headers = { 'User-Agent': userAgent, 'Referer': `${baseUrl}/` };
        
        let videoId = null;
        const hashMatch = playerUrl.match(/#([a-zA-Z0-9]+)$/);
        if (hashMatch) {
            videoId = hashMatch[1];
        } else {
             // Quick fallback check in URL params
             const urlParams = urlObj.searchParams;
             videoId = urlParams.get('id') || urlParams.get('video') || urlParams.get('v');
        }

        if (!videoId) {
             // Try fetching page if needed (simplified for speed, can add page scraping if needed)
             const pathMatch = playerUrl.match(/\/([a-zA-Z0-9]{5,})(?:\/|$|#)/);
             if (pathMatch) videoId = pathMatch[1];
        }

        if (!videoId) return null;

        const apiUrl = `${baseUrl}/api/v1/video?id=${videoId}&w=1920&h=1200&r=`;
        const apiResponse = await axios.get(apiUrl, { headers, timeout: 10000 });
        
        const decryptedText = decryptUpns(apiResponse.data, UPNS_KEY_HEX);
        if (!decryptedText) return null;

        const sourceMatch = decryptedText.match(/"source"\s*:\s*"([^"]+)"/);
        if (!sourceMatch) return null;

        let streamUrl = sourceMatch[1].replace(/\\\//g, '/');
        if (streamUrl && !streamUrl.startsWith('http')) {
            streamUrl = new URL(streamUrl, baseUrl).toString();
        }

        return { streamUrl, headers: { ...headers, 'Origin': baseUrl } };
    } catch (e) {
        console.error('UPNS Error:', e.message);
        return null;
    }
}

// --- STRMUP Extractor Logic ---
function decodePrintable95(encodedHexString, shift) {
    if (!encodedHexString) return "";
    try {
        const intermediateString = Buffer.from(encodedHexString, 'hex').toString('latin1');
        let decodedChars = [];
        for (let index = 0; index < intermediateString.length; index++) {
            const charCode = intermediateString.charCodeAt(index);
            const s = charCode - 32;
            const i = (s - shift - index) % 95;
            const newCharCode = i + 32;
            decodedChars.push(String.fromCharCode(newCharCode));
        }
        return decodedChars.join('');
    } catch (error) { return ""; }
}

async function extractFromStrmup(playerUrl) {
    try {
        const userAgent = getRandomUserAgent();
        const pageResponse = await axios.get(playerUrl, { headers: { 'User-Agent': userAgent }, timeout: 10000 });
        const pageContent = pageResponse.data;
        const urlObj = new URL(playerUrl);
        const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

        let streamUrl = null;

        // Method 1: decodePrintable95
        if (pageContent.includes('decodePrintable95')) {
            const encodedMatch = pageContent.match(/decodePrintable95\("([a-f0-9]+)"/);
            const shiftMatch = pageContent.match(/__enc_shift\s*=\s*(\d+)/);
            if (encodedMatch && shiftMatch) {
                streamUrl = decodePrintable95(encodedMatch[1], parseInt(shiftMatch[1]));
            }
        }

        if (!streamUrl) {
             // Fallback: API check
             const mediaId = playerUrl.split('/').pop();
             const sUrl = `${baseUrl}/ajax/stream?filecode=${mediaId}`;
             try {
                const sResponse = await axios.get(sUrl, { headers: { 'User-Agent': userAgent }, timeout: 5000 });
                if (sResponse.data && sResponse.data.streaming_url) {
                    streamUrl = sResponse.data.streaming_url;
                }
             } catch(e) {}
        }

        if (streamUrl) {
            return { streamUrl, headers: { 'User-Agent': userAgent, 'Referer': baseUrl + '/', 'Origin': baseUrl } };
        }
        return null;
    } catch (e) {
        console.error('Strmup Error:', e.message);
        return null;
    }
}

// --- BSYE Extractor Logic ---
function ft(e) {
    let t = e.replace(/-/g, "+").replace(/_/g, "/");
    let r = t.length % 4 === 0 ? 0 : 4 - (t.length % 4);
    let n = t + "=".repeat(r);
    return Buffer.from(n, 'base64');
}
function xn(e) { return Buffer.concat(e.map(part => ft(part))); }

async function extractFromBsye(url) {
    try {
        const match = url.match(/\/(?:e|d)\/([0-9a-zA-Z]+)/);
        if (!match) return null;
        const mediaId = match[1];
        const parsedUrl = new URL(url);
        const host = parsedUrl.host;
        const apiUrl = `https://${host}/api/videos/${mediaId}/embed/playback`;

        const response = await axios.get(apiUrl, { 
            headers: { 
                "User-Agent": getRandomUserAgent(), 
                "Referer": url, 
                "X-Requested-With": "XMLHttpRequest", 
                "Accept": "application/json" 
            }, timeout: 15000 
        });

        let sources = response.data?.sources;
        if (!sources && response.data?.playback) {
             const pd = response.data.playback;
             try {
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
             } catch (e) {}
        }

        if (sources && sources.length > 0) {
            const hlsSource = sources.find(s => (s.file || s.url || s.src || '').includes('.m3u8')) || sources[0];
            const fileUrl = hlsSource.file || hlsSource.url || hlsSource.src;
            if (fileUrl) {
                return { streamUrl: fileUrl, headers: { "User-Agent": getRandomUserAgent(), "Referer": `https://${host}/`, "Origin": `https://${host}` } };
            }
        }
        return null;
    } catch (e) {
        console.error('BSYE Error:', e.message);
        return null;
    }
}

// --- SWISH/Packer Extractor Logic ---
function unpack(packed) {
    try {
        const argsStart = packed.indexOf("}('");
        if (argsStart === -1) return null;
        const splitIndex = packed.lastIndexOf(".split('|')");
        if (splitIndex === -1) return null;
        const argsEnd = splitIndex; 
        const argsBody = packed.substring(argsStart + 2, argsEnd); 
        const separatorRegex = /',(\d+),(\d+),'/g;
        let match;
        let lastMatch = null;
        while ((match = separatorRegex.exec(argsBody)) !== null) { lastMatch = match; }
        if (!lastMatch) return null;
        const radix = parseInt(lastMatch[1]);
        const count = parseInt(lastMatch[2]);
        const payload = argsBody.substring(0, lastMatch.index);
        const keywordsPart = argsBody.substring(lastMatch.index + lastMatch[0].length);
        const keywordsStr = keywordsPart.substring(0, keywordsPart.length - 1);
        const keywords = keywordsStr.split('|');
        const decode = function(c) {
            return (c < radix ? '' : decode(parseInt(c / radix))) + ((c = c % radix) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
        };
        let unpacked = payload;
        for (let i = count - 1; i >= 0; i--) {
            if (keywords[i]) {
                const key = decode(i);
                let regex = new RegExp('\\b' + key + '\\b', 'g');
                unpacked = unpacked.replace(regex, keywords[i]);
            }
        }
        return unpacked;
    } catch (e) { return null; }
}

async function extractFromSwish(playerUrl) {
    try {
        const userAgent = getRandomUserAgent();
        const response = await axios.get(playerUrl, { headers: { 'User-Agent': userAgent }, timeout: 10000 });
        const html = response.data;
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
            return { streamUrl: streamUrl.replace(/\\/g, ''), headers: { 'User-Agent': userAgent, 'Referer': playerUrl, 'Origin': new URL(playerUrl).origin } };
        }
        return null;
    } catch (e) {
        console.error('Swish Error:', e.message);
        return null;
    }
}

// --- ASCDN/Generic Extractor ---
async function extractFromAsCdn(playerUrl) {
    try {
        const userAgent = getRandomUserAgent();
        const response = await axios.get(playerUrl, { headers: { 'User-Agent': userAgent }, timeout: 10000 });
        const html = normalizeHtml(response.data);
        const match = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/);
        if (match) {
             return { streamUrl: match[1], headers: { 'User-Agent': userAgent, 'Referer': playerUrl } };
        }
        return null;
    } catch (e) {
        console.error('Generic Error:', e.message);
        return null;
    }
}

// --- MAIN DISPATCHER ---
async function extractUniversal(playerUrl) {
    if (!playerUrl) return null;

    try {
        const urlObj = new URL(playerUrl);
        const hostname = urlObj.hostname;

        if (hostname.includes('uns.bio') || hostname.includes('upns.one') || hostname.includes('rpmhub.site') || hostname.includes('p2pplay.pro')) {
            console.log(`[Universal] Using UPNS extractor for ${hostname}`);
            return await extractFromUpns(playerUrl);
        }
        
        if (hostname.includes('strmup') || hostname.includes('streamup')) {
            console.log(`[Universal] Using Strmup extractor for ${hostname}`);
            return await extractFromStrmup(playerUrl);
        }

        if (hostname.includes('multimoviesshg.com') || hostname.includes('hanerix.com') || hostname.includes('smoothpre.com')) {
            console.log(`[Universal] Using Swish extractor for ${hostname}`);
            const result = await extractFromSwish(playerUrl);
            if (result) return result;
        }

        if (playerUrl.includes('/e/') || playerUrl.includes('/d/')) {
            console.log(`[Universal] Using BSYE extractor for ${hostname}`);
            const result = await extractFromBsye(playerUrl);
            if (result) return result;
        }

        console.log(`[Universal] Using ASCDN/Generic extractor for ${hostname}`);
        return await extractFromAsCdn(playerUrl);

    } catch (error) {
        console.error(`[Universal] Error extracting from ${playerUrl}:`, error.message);
        return null;
    }
}

module.exports = { extractUniversal };
