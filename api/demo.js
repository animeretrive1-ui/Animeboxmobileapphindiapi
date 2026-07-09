// This endpoint mimics the behavior of d:\testing purpse\test_vercel_local.js
// It wraps the main API handler but forces specific query parameters
const handler = require('./index');

module.exports = async (req, res) => {
    // Override the query parameters to match the test case, but allow user overrides
    const { tmdbId, season, episode, type } = req.query;

    req.query = {
        tmdbId: tmdbId || '61663',
        season: season || '1',
        episode: episode || '3',
        type: type || 'series' // Explicitly set type to match the expected behavior for a show
    };

    // Delegate execution to the main API handler
    return handler(req, res);
};
