// Simulate Vercel Serverless Function Environment
require('dotenv').config();
const handler = require('./api/index');

const req = {
    method: 'GET',
    query: {
        tmdbId: '61663',
        season: '1',
        episode: '3'
    }
};

const res = {
    statusCode: 200,
    headers: {},
    setHeader: (key, value) => {
        res.headers[key] = value;
    },
    status: (code) => {
        res.statusCode = code;
        return res;
    },
    json: (data) => {
        console.log(`Response [${res.statusCode}]:`);
        console.log(JSON.stringify(data, null, 2));
    },
    end: () => {
        console.log(`Response ended [${res.statusCode}]`);
    }
};

console.log('Running local Vercel function test...');
handler(req, res);
