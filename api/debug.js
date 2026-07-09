const axios = require('axios');
const { getFileSlug, getEmbedData } = require('../lib/extractor');

module.exports = async (req, res) => {
    const results = {
        env: process.env.VERCEL ? 'Vercel' : 'Local',
        step1_slug: { status: 'pending' },
        step2_embed: { status: 'pending' },
        connectivity: {}
    };

    try {
        // Test 1: Connectivity to Google (Baseline)
        try {
            await axios.get('https://www.google.com', { timeout: 5000 });
            results.connectivity.google = 'OK';
        } catch (e) {
            results.connectivity.google = `Failed: ${e.message}`;
        }

        // Test 2: Connectivity to stream.techinmind.space (Step 1 Host)
        try {
            await axios.get('https://stream.techinmind.space', { timeout: 5000 });
            results.connectivity.techinmind = 'OK';
        } catch (e) {
            results.connectivity.techinmind = `Failed: ${e.message}`;
        }

        // Test 3: Actual Step 1 Call (Get Slug)
        try {
            const tmdbId = '61663';
            const season = '1';
            const episode = '4';
            const type = 'series';
            const slug = await getFileSlug(tmdbId, season, episode, null, type);
            results.step1_slug = { status: 'success', slug: slug };
        } catch (e) {
            results.step1_slug = { 
                status: 'failed', 
                error: e.message, 
                statusCode: e.response ? e.response.status : 'N/A',
                data: e.response ? e.response.data : 'N/A'
            };
        }

        // Test 4: Actual Step 2 Call (Get Embed) - only if slug worked or use a known one
        const testSlug = results.step1_slug.slug || 'tk40nwz'; // Use known slug if step 1 failed
        try {
            const embedData = await getEmbedData(testSlug);
            results.step2_embed = { 
                status: 'success', 
                mresult_length: embedData.mresult ? embedData.mresult.length : 0 
            };
        } catch (e) {
            results.step2_embed = { 
                status: 'failed', 
                error: e.message, 
                statusCode: e.response ? e.response.status : 'N/A',
                data: e.response ? e.response.data : 'N/A'
            };
        }

        res.status(200).json(results);

    } catch (error) {
        res.status(500).json({ error: 'Debug script crashed', details: error.message });
    }
};
