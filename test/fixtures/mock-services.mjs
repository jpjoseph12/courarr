// Stand-ins for Maintainerr and a webhook receiver, for end-to-end tests:
//   node test/fixtures/mock-services.mjs   (Maintainerr on :7075, webhook sink on :7099)
// GET http://localhost:7099/received returns every webhook body received so far.
import http from 'node:http';

const COLLECTIONS = [
  { id: 1, title: 'Series - Abandonment', type: 'show', isActive: true, mediaCount: 1 },
  { id: 2, title: 'Keep Latest Season - TV', type: 'season', isActive: true, mediaCount: 0 },
];
const ITEMS = {
  1: [
    {
      id: 10, collectionId: 1, mediaServerId: '5001', tmdbId: 1396, tvdbId: 81189,
      mediaData: { title: 'Breaking Bad', type: 'show', providerIds: { imdb: ['tt0903747'], tmdb: ['1396'], tvdb: ['81189'] } },
    },
  ],
  2: [],
};

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

export function startMaintainerr(port = 7075) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let m;
    if (url.pathname === '/api/collections') return json(res, 200, COLLECTIONS);
    if ((m = url.pathname.match(/^\/api\/collections\/media\/(\d+)\/content\/(\d+)$/))) {
      const items = ITEMS[m[1]] || [];
      return json(res, 200, { totalSize: items.length, items: Number(m[2]) === 1 ? items : [] });
    }
    json(res, 404, { message: 'Not Found' });
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

export function startWebhookSink(port = 7099) {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/received') return json(res, 200, received);
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push(body);
      }
      json(res, 200, { ok: true });
    });
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

if (process.argv[1]?.endsWith('mock-services.mjs')) {
  await startMaintainerr();
  await startWebhookSink();
  console.log('mock Maintainerr on :7075, webhook sink on :7099');
}
