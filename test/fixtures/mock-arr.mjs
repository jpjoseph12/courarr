// A stand-in for the Sonarr / Radarr v3 API: just enough for Courarr's client, with every
// write recorded in `state` so tests can assert what Courarr asked for.
import http from 'node:http';

export const API_KEY = 'arrkey';

export function startArr(kind, port = 0) {
  const sonarr = kind === 'sonarr';
  const state = {
    library: sonarr
      ? [
          {
            id: 1, title: 'Owned Show', tvdbId: 9003, tmdbId: 0, imdbId: 'tt0000103', monitorNewItems: 'all',
            seasons: [
              { seasonNumber: 0, monitored: false, statistics: { episodeFileCount: 0 } },
              { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 12 } },
              { seasonNumber: 2, monitored: true, statistics: { episodeFileCount: 0 } },
            ],
          },
        ]
      : [{ id: 1, title: 'Owned Film', tmdbId: 7005, imdbId: 'tt0000105' }],
    importLists: new Map(),
    nextListId: 1,
    exclusions: sonarr ? [{ tvdbId: 424242, title: 'Excluded Show' }] : [{ tmdbId: 7777, movieTitle: 'Excluded Film' }],
    commands: [],
    seriesPuts: [],
  };
  const lookups = sonarr
    ? [{ title: 'Gamma Unmapped', year: 2026, tvdbId: 9004, alternateTitles: [{ title: 'Gamma' }] }, { title: 'Gamma Unmapped', year: 1999, tvdbId: 1 }]
    : [{ title: 'Delta Movie', originalTitle: 'Delta', year: 2016, tmdbId: 7005 }];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.headers['x-api-key'] !== API_KEY) return send(401, { error: 'Unauthorized' });
    let raw = '';
    req.on('data', (c) => (raw += c)).on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const p = url.pathname.replace(/^\/api\/v3/, '');
      let m;
      if (p === '/system/status') return send(200, { appName: sonarr ? 'Sonarr' : 'Radarr', version: sonarr ? '4.0.20' : '6.4.4' });
      if (p === (sonarr ? '/series' : '/movie') && req.method === 'GET') return send(200, state.library);
      if (p.endsWith('/lookup')) {
        const term = url.searchParams.get('term') || '';
        if (term.startsWith('tmdb:')) return send(200, term === 'tmdb:126308' ? [{ title: 'Shōgun', tvdbId: 392573, imdbId: 'tt2788316' }] : []);
        if (term.startsWith('imdb:')) return send(200, term === 'imdb:tt0000106' ? [{ title: 'Epsilon Film', tmdbId: 7006 }] : []);
        if (term === 'boom') return send(500, { error: 'lookup exploded' });
        return send(200, lookups.filter((l) => l.title.toLowerCase().includes(term.toLowerCase())));
      }
      if (p === '/rootfolder') return send(200, [{ path: sonarr ? '/tv' : '/movies', freeSpace: 5e12 }, { path: '/anime', freeSpace: 1e12 }]);
      if (p === '/qualityprofile') return send(200, [{ id: 1, name: 'Any' }, { id: 4, name: 'HD-1080p' }]);
      if (p === '/tag') return send(200, [{ id: 3, label: 'courarr' }]);
      if (p === '/importlist/schema') {
        return send(200, [
          { implementation: 'SomethingElse', fields: [] },
          { implementation: sonarr ? 'CustomImport' : 'RadarrListImport', fields: [{ name: sonarr ? 'baseUrl' : 'url', value: '' }] },
        ]);
      }
      if (p === '/importlist' && req.method === 'POST') {
        const id = state.nextListId++;
        state.importLists.set(id, { ...body, id });
        return send(201, state.importLists.get(id));
      }
      if ((m = p.match(/^\/importlist\/(\d+)$/))) {
        const id = Number(m[1]);
        if (req.method === 'DELETE') {
          state.importLists.delete(id);
          return send(200, {});
        }
        if (!state.importLists.has(id)) return send(404, { message: 'NotFound' });
        if (req.method === 'PUT') state.importLists.set(id, { ...body, id });
        return send(200, state.importLists.get(id));
      }
      if (sonarr && p === '/importlistexclusion') return send(200, state.exclusions);
      if (!sonarr && p === '/exclusions') return send(200, state.exclusions);
      if (p === '/command' && req.method === 'POST') {
        state.commands.push(body.name);
        return send(201, { id: state.commands.length, name: body.name });
      }
      if (sonarr && (m = p.match(/^\/series\/(\d+)$/)) && req.method === 'PUT') {
        state.seriesPuts.push(body);
        const i = state.library.findIndex((s) => s.id === Number(m[1]));
        state.library[i] = body;
        return send(202, body);
      }
      send(404, { message: 'NotFound' });
    });
  });
  return new Promise((r) => server.listen(port, () => r({ server, state })));
}
