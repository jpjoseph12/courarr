import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG_DIR } from './config.js';

export const db = new DatabaseSync(path.join(CONFIG_DIR, 'courarr.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS lists (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    slug         TEXT NOT NULL UNIQUE,
    source       TEXT NOT NULL DEFAULT 'anilist' CHECK (source IN ('anilist', 'tmdb')),
    target       TEXT NOT NULL CHECK (target IN ('sonarr', 'radarr')),
    filters      TEXT NOT NULL,
    arr_list_id  INTEGER,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_refresh TEXT,
    last_error   TEXT
  );

  CREATE TABLE IF NOT EXISTS list_items (
    list_id    INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    item_key   INTEGER NOT NULL,
    position   INTEGER NOT NULL,
    data       TEXT NOT NULL,
    PRIMARY KEY (list_id, item_key)
  );

  CREATE TABLE IF NOT EXISTS exclusions (
    list_id    INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    item_key   INTEGER NOT NULL,
    title      TEXT,
    PRIMARY KEY (list_id, item_key)
  );

  CREATE TABLE IF NOT EXISTS overrides (
    anilist_id INTEGER PRIMARY KEY,
    tvdb_id    INTEGER,
    tmdb_id    INTEGER,
    title      TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Summarised TMDB /tv and /movie details (ids, seasons, ratings…): one call per title, so cache.
  DROP TABLE IF EXISTS tmdb_tv_ids;
  CREATE TABLE IF NOT EXISTS tmdb_details (
    kind       TEXT NOT NULL,
    tmdb_id    INTEGER NOT NULL,
    data       TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (kind, tmdb_id)
  );

  CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger     TEXT NOT NULL,
    status      TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    summary     TEXT
  );
`);

export const now = () => new Date().toISOString();

// ---------- settings ----------

export const SETTING_DEFAULTS = {
  schedule: '0 3 * * *',
  seasonRolloverDays: 14,
  feedBaseUrl: '',
  sonarrUrl: '',
  sonarrApiKey: '',
  radarrUrl: '',
  radarrApiKey: '',
  arrLookupFallback: true,
  triggerArrSync: true,
  titleLanguage: 'english',
  tmdbApiKey: '',
  tmdbRegion: 'US',
};

export function getSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    if (row.key in SETTING_DEFAULTS) out[row.key] = JSON.parse(row.value);
  }
  return out;
}

export function saveSettings(patch) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [key, value] of Object.entries(patch)) {
    if (key in SETTING_DEFAULTS) stmt.run(key, JSON.stringify(value));
  }
  return getSettings();
}

// ---------- lists ----------

function rowToList(row) {
  if (!row) return null;
  return { ...row, enabled: !!row.enabled, filters: JSON.parse(row.filters) };
}

export function listLists() {
  return db
    .prepare(
      `SELECT l.*,
         (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) AS item_count,
         (SELECT COUNT(*) FROM exclusions e WHERE e.list_id = l.id) AS excluded_count
       FROM lists l ORDER BY l.name COLLATE NOCASE`,
    )
    .all()
    .map(rowToList);
}

export const getList = (id) => rowToList(db.prepare('SELECT * FROM lists WHERE id = ?').get(id));
export const getListBySlug = (slug) =>
  rowToList(db.prepare('SELECT * FROM lists WHERE slug = ?').get(slug));

export function createList({ name, slug, source, target, filters, enabled = true }) {
  const res = db
    .prepare('INSERT INTO lists (name, slug, source, target, filters, enabled) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, slug, source, target, JSON.stringify(filters), enabled ? 1 : 0);
  return getList(res.lastInsertRowid);
}

export function updateList(id, { name, slug, source, target, filters, enabled }) {
  const prev = getList(id);
  // The Sonarr/Radarr import list belongs to one app; forget it if the target changes.
  const arrListId = prev && prev.target === target ? prev.arr_list_id : null;
  db.prepare(
    `UPDATE lists SET name = ?, slug = ?, source = ?, target = ?, filters = ?, enabled = ?,
       arr_list_id = ?, updated_at = ? WHERE id = ?`,
  ).run(name, slug, source, target, JSON.stringify(filters), enabled ? 1 : 0, arrListId, now(), id);
  return getList(id);
}

export const setArrListId = (id, arrListId) =>
  db.prepare('UPDATE lists SET arr_list_id = ? WHERE id = ?').run(arrListId, id);

export const deleteList = (id) => db.prepare('DELETE FROM lists WHERE id = ?').run(id);

export function slugTaken(slug, exceptId = 0) {
  return !!db.prepare('SELECT 1 FROM lists WHERE slug = ? AND id != ?').get(slug, exceptId);
}

export function saveListItems(listId, items, error = null) {
  db.exec('BEGIN');
  try {
    if (!error) {
      db.prepare('DELETE FROM list_items WHERE list_id = ?').run(listId);
      const ins = db.prepare(
        'INSERT OR REPLACE INTO list_items (list_id, item_key, position, data) VALUES (?, ?, ?, ?)',
      );
      items.forEach((it, i) => ins.run(listId, it.key, i, JSON.stringify(it)));
    }
    db.prepare('UPDATE lists SET last_refresh = ?, last_error = ? WHERE id = ?').run(
      now(),
      error,
      listId,
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getListItems(listId) {
  const excluded = getExclusionIds(listId);
  return db
    .prepare('SELECT data FROM list_items WHERE list_id = ? ORDER BY position')
    .all(listId)
    .map((r) => {
      const item = JSON.parse(r.data);
      item.excluded = excluded.has(item.key);
      return item;
    });
}

// ---------- exclusions ----------

export function getExclusionIds(listId) {
  return new Set(
    db
      .prepare('SELECT item_key FROM exclusions WHERE list_id = ?')
      .all(listId)
      .map((r) => r.item_key),
  );
}

export const listExclusions = (listId) =>
  db.prepare('SELECT item_key, title FROM exclusions WHERE list_id = ? ORDER BY title').all(listId);

export const addExclusion = (listId, key, title) =>
  db
    .prepare('INSERT OR REPLACE INTO exclusions (list_id, item_key, title) VALUES (?, ?, ?)')
    .run(listId, key, title ?? null);

export const removeExclusion = (listId, key) =>
  db.prepare('DELETE FROM exclusions WHERE list_id = ? AND item_key = ?').run(listId, key);

// ---------- TMDB details cache ----------

export function getTmdbDetails(kind, tmdbId) {
  const row = db.prepare('SELECT data, fetched_at FROM tmdb_details WHERE kind = ? AND tmdb_id = ?').get(kind, tmdbId);
  return row ? { data: JSON.parse(row.data), fetched_at: row.fetched_at } : null;
}

export const saveTmdbDetails = (kind, tmdbId, data) =>
  db
    .prepare(
      `INSERT INTO tmdb_details (kind, tmdb_id, data, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, tmdb_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
    )
    .run(kind, tmdbId, JSON.stringify(data), now());

// ---------- overrides ----------

export const listOverrides = () =>
  db.prepare('SELECT * FROM overrides ORDER BY updated_at DESC').all();

export function getOverrideMap() {
  return new Map(listOverrides().map((o) => [o.anilist_id, o]));
}

export function setOverride(anilistId, { tvdbId, tmdbId, title }) {
  const existing = db.prepare('SELECT * FROM overrides WHERE anilist_id = ?').get(anilistId) || {};
  const tvdb = tvdbId === undefined ? (existing.tvdb_id ?? null) : tvdbId;
  const tmdb = tmdbId === undefined ? (existing.tmdb_id ?? null) : tmdbId;
  if (tvdb == null && tmdb == null) {
    db.prepare('DELETE FROM overrides WHERE anilist_id = ?').run(anilistId);
    return null;
  }
  db.prepare(
    `INSERT INTO overrides (anilist_id, tvdb_id, tmdb_id, title, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(anilist_id) DO UPDATE SET tvdb_id = excluded.tvdb_id, tmdb_id = excluded.tmdb_id,
       title = COALESCE(excluded.title, overrides.title), updated_at = excluded.updated_at`,
  ).run(anilistId, tvdb, tmdb, title ?? existing.title ?? null, now());
  return db.prepare('SELECT * FROM overrides WHERE anilist_id = ?').get(anilistId);
}

export const deleteOverride = (anilistId) =>
  db.prepare('DELETE FROM overrides WHERE anilist_id = ?').run(anilistId);

// ---------- runs ----------

export function startRun(trigger) {
  return db
    .prepare("INSERT INTO runs (trigger, status, started_at) VALUES (?, 'running', ?)")
    .run(trigger, now()).lastInsertRowid;
}

export function finishRun(id, status, summary) {
  db.prepare('UPDATE runs SET status = ?, finished_at = ?, summary = ? WHERE id = ?').run(
    status,
    now(),
    JSON.stringify(summary),
    id,
  );
  // Keep the activity log bounded.
  db.prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT 200)').run();
}

export function listRuns(limit = 50) {
  return db
    .prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null }));
}

// A run left 'running' by a crash/restart is not running any more.
db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now());
