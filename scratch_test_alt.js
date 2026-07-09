const axios = require('axios');

async function test() {
    const urls = [
        'https://ssn.iqsmartgames.com/myseriesapi?tmdbid=95479&season=2&epname=1&key=e11a7debaaa4f5d25b671706ffe4d2acb56efbd4',
        'https://pro.iqsmartgames.com/myseriesapi?tmdbid=95479&season=2&epname=1&key=e11a7debaaa4f5d25b671706ffe4d2acb56efbd4'
    ];

    for (const url of urls) {
        console.log(`\nTesting URL: ${url}`);
        try {
            const res = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://pro.iqsmartgames.com/',
                    'Origin': 'https://pro.iqsmartgames.com'
                }
            });
            console.log(`Response status: ${res.status}`);
            console.log(`Response snippet:`, JSON.stringify(res.data).slice(0, 200));
        } catch (e) {
            console.log(`Error: ${e.message}`);
        }
    }
}

test();
