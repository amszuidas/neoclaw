/**
 * MemoryManager — memory lifecycle management and tool handlers.
 *
 * Provides:
 * - memory_search / memory_save / memory_list tool handlers (registered on Agent)
 * - Session summarization on /clear or /new
 * - Index rebuild on startup
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { MemoryEntry, MemoryStore } from './store.js';
import { summarizeTranscript } from './summarizer.js';
import { Config } from '../config';

const log = logger('memory');

const REINDEX_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Format a memory entry into a structured, readable string. */
function formatEntry(e: MemoryEntry): string {
  const lines = [`id: ${e.id}`, `title: ${e.title}`, `category: ${e.category}`, `date: ${e.date}`];
  if (e.tags.length > 0) lines.push(`tags: ${e.tags.join(', ')}`);
  lines.push('', e.content);
  return lines.join('\n');
}

export const KNOWLEDGE_TOPICS = {
  'owner-profile': 'Owner personal info, background, career',
  preferences: 'Preferences, habits, tools, workflow',
  people: 'People and contacts',
  projects: 'Project notes, technical decisions',
  notes: 'General knowledge and miscellaneous',
} as const;

export type KnowledgeTopic = keyof typeof KNOWLEDGE_TOPICS;

export class MemoryManager {
  private _reindexTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly memoryDir: string,
    private readonly store: MemoryStore
  ) {}

  // ── Tool handlers (return stringified results for the agent) ──

  async handleRead(input: unknown): Promise<string> {
    log.debug(`handleRead: ${JSON.stringify(input, null, 2)}`);

    const { id } = input as { id: string };
    if (!id) {
      log.warn('handleRead: "id" is required.');
      return 'Error: "id" is required.';
    }

    try {
      const entry = this.store.get(id);
      if (!entry) {
        log.warn(`handleRead: No memory found with id "${id}".`);
        return `No memory found with id "${id}".`;
      }

      return formatEntry(entry);
    } catch (err) {
      return `Read error: ${err}`;
    }
  }

  async handleSearch(input: unknown): Promise<string> {
    log.debug(`handleSearch: ${JSON.stringify(input, null, 2)}`);

    const { query, category } = input as { query: string; category?: string };
    if (!query) {
      log.warn('handleSearch: "query" is required.');
      return 'Error: "query" is required.';
    }

    try {
      const results = this.store.search(query, {
        category: category as 'episode' | 'knowledge' | undefined,
        limit: 5,
      });

      if (results.length === 0) return 'No matching memories found.';

      return results.map((r) => formatEntry(r)).join('\n\n---\n\n');
    } catch (err) {
      return `Search error: ${err}`;
    }
  }

  async handleSave(input: unknown): Promise<string> {
    log.debug(`handleSave: ${JSON.stringify(input, null, 2)}`);

    const raw = input as Record<string, unknown>;
    // Accept both "id" (preferred) and "topic" (legacy) for backward compatibility
    const id = (raw.id ?? raw.topic) as string | undefined;
    const content = raw.content as string | undefined;
    const tags = raw.tags as string[] | undefined;
    const category = raw.category as string | undefined;

    if (!content) {
      log.warn('handleSave: "content" is required.');
      return 'Error: "content" is required.';
    }

    try {
      const date = new Date().toISOString().slice(0, 10);
      const tagList = tags ?? [];

      let dirName: string;
      let fileName: string;
      let title: string;
      let entryId: string;

      if (category === 'identity') {
        dirName = 'identity';
        fileName = 'SOUL.md';
        entryId = 'SOUL';
        title = (id as string) || 'Soul — Personality & Values';
        if (!tagList.length) tagList.push('identity', 'personality');
      } else {
        if (!id) return 'Error: "id" is required for knowledge memory.';
        if (!(id in KNOWLEDGE_TOPICS))
          return `Error: invalid id "${id}". Must be one of: ${Object.keys(KNOWLEDGE_TOPICS).join(', ')}`;
        dirName = 'knowledge';
        fileName = `${id}.md`;
        entryId = id;
        title = KNOWLEDGE_TOPICS[id as KnowledgeTopic];
      }

      const frontmatter = [
        '---',
        `title: "${title}"`,
        `date: ${date}`,
        `tags: [${tagList.join(', ')}]`,
        '---',
      ].join('\n');
      const markdown = `${frontmatter}\n\n${content}\n`;

      const targetDir = join(this.memoryDir, dirName);
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, fileName), markdown, 'utf-8');

      this.store.upsert({
        id: entryId,
        category: category === 'identity' ? 'identity' : 'knowledge',
        title,
        content,
        tags: tagList,
        date,
      });

      log.info(`Saved ${category ?? 'knowledge'}: "${entryId}" (${dirName}/${fileName})`);
      return `Saved: id="${entryId}", category="${category ?? 'knowledge'}", file="${dirName}/${fileName}"`;
    } catch (err) {
      return `Save error: ${err}`;
    }
  }

  async handleList(input: unknown): Promise<string> {
    log.debug(`handleList: ${JSON.stringify(input, null, 2)}`);

    const { category } = (input ?? {}) as { category?: string };

    try {
      const items = this.store.list({
        category: category as 'episode' | 'knowledge' | undefined,
      });

      if (items.length === 0) return 'No memories stored yet.';

      const lines = items.map((item) => {
        const tagStr = item.tags.length > 0 ? `  tags: ${item.tags.join(', ')}` : '';
        return `- id: ${item.id}  |  title: ${item.title}  |  category: ${item.category}  |  date: ${item.date}${tagStr}`;
      });
      return lines.join('\n');
    } catch (err) {
      return `List error: ${err}`;
    }
  }

  // ── Session summarization ─────────────────────────────────

  /**
   * Generate an episodic memory entry from conversation history.
   * Called before /clear or /new wipes the session.
   */
  async summarizeSession(conversationId: string, workspacesDir: string): Promise<void> {
    const sanitized = conversationId.replace(/:/g, '_');
    const historyDir = join(workspacesDir, sanitized, '.neoclaw', '.history');

    if (!existsSync(historyDir)) {
      log.warn(`No history directory for "${conversationId}", skipping summarization`);
      return;
    }

    // Collect all history files, sorted by date
    let files: string[];
    try {
      files = readdirSync(historyDir)
        .filter((f) => f.endsWith('.txt'))
        .sort();
    } catch (err) {
      log.warn(`Error reading history directory for "${conversationId}": ${err}`);
      return;
    }

    if (files.length === 0) return;

    // Read the offset marker: { "<filename>": <byteOffset>, ... }
    // This tracks how far we've already summarized in each file.
    const markerPath = join(historyDir, '.last-summarized-offset');
    let offsets: Record<string, number> = {};
    try {
      if (existsSync(markerPath)) {
        offsets = JSON.parse(readFileSync(markerPath, 'utf-8'));
      }
    } catch (err) {
      log.warn(`Error reading offset marker for "${conversationId}": ${err}`);
      offsets = {};
    }

    // Only read unsummarized content from each file
    const newParts: string[] = [];
    const newOffsets: Record<string, number> = { ...offsets };

    for (const file of files) {
      const filePath = join(historyDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const prevOffset = offsets[file] ?? 0;

      if (prevOffset >= content.length) continue; // already fully summarized
      const newContent = content.slice(prevOffset).trim();
      if (newContent) newParts.push(newContent);

      newOffsets[file] = content.length;
    }

    if (newParts.length === 0) {
      log.info(`No new history for "${conversationId}", skipping summarization`);
      return;
    }

    const transcript = newParts.join('\n').trim();

    if (transcript.length < 100) {
      // Still update offsets so we don't re-read this tiny content next time
      writeFileSync(markerPath, JSON.stringify(newOffsets, null, 2), 'utf-8');
      log.info(`Transcript too short for "${conversationId}", skipping summarization`);
      return;
    }

    // Truncate very long transcripts to reduce timeout risk
    const maxChars = 20_000;
    const truncated = transcript.length > maxChars ? transcript.slice(-maxChars) : transcript;
    const rawChars = transcript.length;
    const truncatedChars = truncated.length;
    const summaryTimeoutSecs = Config.get().summaryTimeoutSecs ?? 300;
    const startedAt = Date.now();

    log.info(
      `Summarizing session "${conversationId}": rawChars=${rawChars}, truncatedChars=${truncatedChars}, timeoutSecs=${summaryTimeoutSecs}`
    );

    try {
      const summaryMd = await summarizeTranscript(truncated);

      // Write to episodes/ directory
      const episodesDir = join(this.memoryDir, 'episodes');
      if (!existsSync(episodesDir)) mkdirSync(episodesDir, { recursive: true });

      const date = new Date().toISOString().slice(0, 10);
      const ts = Date.now();
      const suffix = sanitized.slice(0, 20);
      const fileName = `${date}_${suffix}_${ts}.md`;
      writeFileSync(join(episodesDir, fileName), summaryMd, 'utf-8');

      // Re-index this entry
      const id = fileName.replace('.md', '');
      const titleMatch = summaryMd.match(/^title:\s*"?([^"\n]+)"?\s*$/m);
      const title = titleMatch?.[1] ?? `Session ${date}`;

      this.store.upsert({
        id,
        category: 'episode',
        title,
        content: summaryMd,
        tags: [],
        date,
      });

      // Persist offsets only after successful summarization
      writeFileSync(markerPath, JSON.stringify(newOffsets, null, 2), 'utf-8');
      const elapsedMs = Date.now() - startedAt;
      log.info(
        `Session summary saved: ${fileName} (elapsedMs=${elapsedMs}, truncatedChars=${truncatedChars}, timeoutSecs=${summaryTimeoutSecs})`
      );
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      log.warn(
        `Failed to summarize session "${conversationId}" (elapsedMs=${elapsedMs}, truncatedChars=${truncatedChars}, timeoutSecs=${summaryTimeoutSecs}): ${err}`
      );
    }
  }

  // ── Index management ──────────────────────────────────────

  reindex(): void {
    log.info('Rebuilding memory index...');
    this.store.reindex(this.memoryDir);
    const count = this.store.list().length;
    log.info(`Memory index rebuilt: ${count} entries`);
  }

  /** Start periodic reindexing to pick up external file changes. */
  startPeriodicReindex(): void {
    if (this._reindexTimer) return;
    this._reindexTimer = setInterval(() => {
      try {
        this.store.reindex(this.memoryDir);
        log.info('Periodic reindex completed');
      } catch (err) {
        log.warn(`Periodic reindex failed: ${err}`);
      }
    }, REINDEX_INTERVAL_MS);
    if (typeof this._reindexTimer.unref === 'function') this._reindexTimer.unref();
    log.info(`Periodic reindex scheduled every ${REINDEX_INTERVAL_MS / 1000}s`);
  }

  stopPeriodicReindex(): void {
    if (this._reindexTimer) {
      clearInterval(this._reindexTimer);
      this._reindexTimer = null;
    }
  }
}
