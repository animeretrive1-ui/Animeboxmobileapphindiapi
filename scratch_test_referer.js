const axios = require('axios');

async function test() {
    const tmdbId = '95479';
    const season = '2';
    const episode = '1';
    const key = 'e11a7debaaa4f5d25b671706ffe4d2acb56efbd4';

    const url = `https://streams.iqsmartgames.com/myseriesapi?tmdbid=${tmdbId}&season=${season}&epname=${episode}&key=${key}`;
    const referer = `https://streams.iqsmartgames.com/embed/tv/${tmdbId}/${season}/${episode}?key=${key}`;

    console.log(`Testing with exact embed referer: ${referer}`);
    try {
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': referer,
                'Origin': 'https://streams.iqsmartgames.com',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        console.log(`Response status: ${res.status}`);
        console.log(`Response:`, JSON.stringify(res.data));
    } catch (e) {
        console.log(`Error: ${e.message}`);
        if (e.response) {
            console.log(`Status: ${e.response.status}`);
            console.log(`Data:`, JSON.stringify(e.response.data));
        }
    }
}

test();
