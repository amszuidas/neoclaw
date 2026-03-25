/**
 * MemoryStore — SQLite FTS5 index for memory entries.
 *
 * Markdown files under `episodes/` and `knowledge/` are the source of truth.
 * This store provides full-text search over their content.
 */

import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface MemoryEntry {
  /** File name without extension. */
  id: string;
  category: 'episode' | 'knowledge' | 'identity';
  title: string;
  /** Markdown body. */
  content: string;
  tags: string[];
  /** ISO date string. */
  date: string;
}

export class MemoryStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this._initSchema();
  }

  private _initSchema(): void {
    // Regular table for metadata + FTS5 virtual table for full-text search.
    this.db.run(`CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL
    )`);
    this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      id, category, title, content, tags, date,
      content='memory',
      content_rowid='rowid',
      tokenize='unicode61'
    )`);
    // Triggers to keep FTS in sync with the content table
    this.db.run(`CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, id, category, title, content, tags, date)
        VALUES (new.rowid, new.id, new.category, new.title, new.content, new.tags, new.date);
    END`);
    this.db.run(`CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, id, category, title, content, tags, date)
        VALUES ('delete', old.rowid, old.id, old.category, old.title, old.content, old.tags, old.date);
    END`);
    this.db.run(`CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, id, category, title, content, tags, date)
        VALUES ('delete', old.rowid, old.id, old.category, old.title, old.content, old.tags, old.date);
      INSERT INTO memory_fts(rowid, id, category, title, content, tags, date)
        VALUES (new.rowid, new.id, new.category, new.title, new.content, new.tags, new.date);
    END`);
  }

  upsert(entry: MemoryEntry): void {
    const tags = entry.tags.join(',');
    this.db.run(
      `INSERT INTO memory (id, category, title, content, tags, date)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         category=excluded.category, title=excluded.title, content=excluded.content,
         tags=excluded.tags, date=excluded.date`,
      [entry.id, entry.category, entry.title, entry.content, tags, entry.date]
    );
  }

  get(id: string): MemoryEntry | null {
    type Row = {
      id: string;
      category: string;
      title: string;
      content: string;
      tags: string;
      date: string;
    };
    const row = this.db
      .query('SELECT id, category, title, content, tags, date FROM memory WHERE id = ?')
      .get(id) as Row | null;
    if (!row) return null;
    return {
      id: row.id,
      category: row.category as MemoryEntry['category'],
      title: row.title,
      content: row.content,
      tags: row.tags ? row.tags.split(',') : [],
      date: row.date,
    };
  }

  delete(id: string): void {
    this.db.run('DELETE FROM memory WHERE id = ?', [id]);
  }

  search(query: string, opts?: { category?: string; limit?: number }): MemoryEntry[] {
    const limit = opts?.limit ?? 10;

    // Pass 1: exact FTS match (AND logic — all tokens must appear)
    const results = this._ftsSearch(query, opts?.category, limit);

    // Pass 2: if query contains CJK and pass 1 returned too few results,
    // re-search with OR logic across individual characters for better recall.
    // e.g. "女朋友" → "女" OR "朋" OR "友" — matches documents with "女友".
    if (results.length < limit && CJK_RE.test(query)) {
      const orQuery = buildCjkOrQuery(query);
      if (orQuery !== query) {
        const seen = new Set(results.map((r) => r.id));
        const more = this._ftsSearch(orQuery, opts?.category, limit - results.length);
        for (const r of more) {
          if (!seen.has(r.id)) {
            results.push(r);
            seen.add(r.id);
          }
        }
      }
    }

    return results;
  }

  private _ftsSearch(ftsQuery: string, category: string | undefined, limit: number): MemoryEntry[] {
    type Row = {
      id: string;
      category: string;
      title: string;
      content: string;
      tags: string;
      date: string;
    };

    let rows: Row[];
    try {
      if (category) {
        rows = this.db
          .query(
            `SELECT m.id, m.category, m.title, m.content, m.tags, m.date
           FROM memory_fts f JOIN memory m ON f.rowid = m.rowid
           WHERE memory_fts MATCH ? AND m.category = ?
           ORDER BY rank LIMIT ?`
          )
          .all(ftsQuery, category, limit) as Row[];
      } else {
        rows = this.db
          .query(
            `SELECT m.id, m.category, m.title, m.content, m.tags, m.date
           FROM memory_fts f JOIN memory m ON f.rowid = m.rowid
           WHERE memory_fts MATCH ?
           ORDER BY rank LIMIT ?`
          )
          .all(ftsQuery, limit) as Row[];
      }
    } catch {
      // FTS query syntax error (e.g. special chars) — return empty
      rows = [];
    }

    return rows.map((r) => ({
      id: r.id,
      category: r.category as MemoryEntry['category'],
      title: r.title,
      content: r.content,
      tags: r.tags ? r.tags.split(',') : [],
      date: r.date,
    }));
  }

  list(opts?: { category?: string }): Array<{
    id: string;
    title: string;
    category: string;
    tags: string[];
    date: string;
  }> {
    type ListRow = { id: string; title: string; category: string; tags: string; date: string };

    let rows: ListRow[];
    if (opts?.category) {
      rows = this.db
        .query(
          'SELECT id, title, category, tags, date FROM memory WHERE category = ? ORDER BY date DESC'
        )
        .all(opts.category) as ListRow[];
    } else {
      rows = this.db
        .query('SELECT id, title, category, tags, date FROM memory ORDER BY date DESC')
        .all() as ListRow[];
    }

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      category: r.category,
      tags: r.tags ? r.tags.split(',') : [],
      date: r.date,
    }));
  }

  /** Rebuild index from markdown files on disk. */
  reindex(memoryDir: string): void {
    this.db.run('DELETE FROM memory');

    const dirMap = {
      identity: 'identity',
      episodes: 'episode',
      knowledge: 'knowledge',
    } as const;

    for (const [dirName, cat] of Object.entries(dirMap)) {
      const dir = join(memoryDir, dirName);
      if (!existsSync(dir)) continue;

      let entries: string[];
      try {
        entries = readdirSync(dir).filter((f) => f.endsWith('.md'));
      } catch {
        continue;
      }

      for (const file of entries) {
        const content = readFileSync(join(dir, file), 'utf-8');
        const parsed = parseFrontmatter(content);
        const id = basename(file, '.md');

        this.upsert({
          id,
          category: cat as MemoryEntry['category'],
          title: parsed.title || id,
          content: parsed.body,
          tags: parsed.tags,
          date: parsed.date || new Date().toISOString().slice(0, 10),
        });
      }
    }
  }

  close(): void {
    this.db.close();
  }
}

// ── CJK query expansion ──────────────────────────────────────

/** Matches CJK Unified Ideographs + Extension A (covers Chinese, Japanese kanji, Korean hanja). */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * Build an OR-expanded FTS5 query for CJK text.
 * "女朋友" → `"女" OR "朋" OR "友"`
 * Mixed text: "Python项目" → `"Python" OR "项" OR "目"`
 */
function buildCjkOrQuery(raw: string): string {
  const tokens: string[] = [];
  let buf = '';

  for (const ch of raw) {
    if (CJK_RE.test(ch)) {
      if (buf.trim()) {
        tokens.push(...buf.trim().split(/\s+/));
        buf = '';
      }
      tokens.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) tokens.push(...buf.trim().split(/\s+/));

  if (tokens.length <= 1) return raw;
  // Quote each token to prevent FTS5 syntax issues, join with OR
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

// ── Frontmatter parser ────────────────────────────────────────

interface Frontmatter {
  title: string;
  tags: string[];
  date: string;
  body: string;
}

function parseFrontmatter(content: string): Frontmatter {
  const result: Frontmatter = { title: '', tags: [], date: '', body: content };

  if (!content.startsWith('---')) return result;

  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return result;

  const fm = content.slice(3, endIdx).trim();
  result.body = content.slice(endIdx + 3).trim();

  for (const line of fm.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();

    if (key === 'title') {
      result.title = val.replace(/^["']|["']$/g, '');
    } else if (key === 'date') {
      result.date = val;
    } else if (key === 'tags') {
      // Support: tags: [a, b, c] or tags: a, b, c
      const stripped = val.replace(/^\[|\]$/g, '');
      result.tags = stripped
        .split(',')
        .map((t) => t.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
  }

  return result;
}
