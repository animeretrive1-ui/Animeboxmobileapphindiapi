const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const extractHandler = require('./api/index');
const proxyHandler = require('./api/proxy');

const PORT = 3001;

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // Serve static files from /public
    if (pathname === '/' || pathname === '/index.html') {
        const filePath = path.join(__dirname, 'public', 'index.html');
        fs.readFile(filePath, 'utf-8', (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }
            // Patch fetch URL in the HTML to use local API
            const patched = data.replace('/api/extract?', 'http://localhost:' + PORT + '/api/extract?');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(patched);
        });
        return;
    }

    // Mock req/res for our serverless handlers
    const mockReq = {
        method: req.method,
        query: parsedUrl.query,
        headers: req.headers,
        url: req.url
    };

    const mockRes = {
        statusCode: 200,
        headers: {},
        setHeader(key, value) { this.headers[key] = value; },
        status(code) { this.statusCode = code; return this; },
        json(data) {
            if (!res.headersSent) {
                res.writeHead(this.statusCode, {
                    'Content-Type': 'application/json',
                    ...this.headers
                });
            }
            res.end(JSON.stringify(data, null, 2));
        },
        end() {
            if (!res.headersSent) {
                res.writeHead(this.statusCode, this.headers);
            }
            res.end();
        },
        send(data) {
            if (!res.headersSent) {
                res.writeHead(this.statusCode, { 'Content-Type': 'text/plain', ...this.headers });
            }
            res.end(String(data));
        }
    };

    if (pathname === '/api/extract') {
        await extractHandler(mockReq, mockRes);
    } else if (pathname === '/api/proxy') {
        await proxyHandler(mockReq, mockRes);
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found', path: pathname }));
    }
});

server.listen(PORT, () => {
    console.log(`\n🚀 Local API server running at http://localhost:${PORT}`);
    console.log(`\nTest endpoints:`);
    console.log(`  Series: http://localhost:${PORT}/api/extract?tmdbId=95479&season=2&episode=1`);
    console.log(`  Movie:  http://localhost:${PORT}/api/extract?tmdbId=104154&type=movie`);
    console.log(`\nPress Ctrl+C to stop.\n`);
});
