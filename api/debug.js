const { getFileSlug, getEmbedData } = require('../lib/extractor');

module.exports = async (req, res) => {
    const relayUrl = process.env.RELAY_URL || null;

    const results = {
        env: process.env.VERCEL ? 'Vercel' : 'Local',
        relay_url: relayUrl || '(not set — using direct connections)',
        node_version: process.version,
        step1_slug: { status: 'pending' },
        step2_embed: { status: 'pending' },
        connectivity: {}
    };

    // ── Connectivity probes ──────────────────────────────────────────────────
    const probe = async (label, url, opts = {}) => {
        try {
            const r = await fetch(url, { signal: AbortSignal.timeout(8000), ...opts });
            const text = await r.text().catch(() => '');
            // Detect CF bot challenge in response body
            const isCfChallenge = text.includes('Just a moment') || text.includes('cf_chl_opt');
            results.connectivity[label] = isCfChallenge
                ? `CF_CHALLENGE (${r.status}) — bot block`
                : `OK (${r.status})`;
        } catch (e) {
            results.connectivity[label] = `Failed: ${e.message}`;
        }
    };

    await probe('google', 'https://www.google.com');
    await probe('streams_iqsmartgames', 'https://streams.iqsmartgames.com');
    await probe('ssn_iqsmartgames', 'https://ssn.iqsmartgames.com/embedhelper.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'sid=test&UserFavSite=&currentDomain=[]'
    });

    if (relayUrl) {
        await probe('relay_health', `${relayUrl.replace(/\/$/, '')}/health`);
    }

    // ── Step 1: Get slug ─────────────────────────────────────────────────────
    try {
        const slug = await getFileSlug('61663', '1', '4', 'series');
        results.step1_slug = { status: 'success', slug };
    } catch (e) {
        results.step1_slug = { status: 'failed', error: e.message };
    }

    // ── Step 2: Get embed data ───────────────────────────────────────────────
    const testSlug = results.step1_slug.slug || 'tk40nwz';
    try {
        const embedData = await getEmbedData(testSlug);
        results.step2_embed = {
            status: 'success',
            mresult_length: embedData.mresult ? embedData.mresult.length : 0,
        };
    } catch (e) {
        results.step2_embed = { status: 'failed', error: e.message };
    }

    res.status(200).json(results);
};
