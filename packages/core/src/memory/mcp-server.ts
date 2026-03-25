/**
 * Memory MCP Server — stdio-based MCP server exposing memory tools.
 *
 * Spawned by Claude Code as a child process via .mcp.json configuration.
 * Each Claude Code subprocess gets its own instance.
 *
 * Environment variables:
 * - NEOCLAW_MEMORY_DIR: path to the memory directory (default: ~/.neoclaw/memory)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KNOWLEDGE_TOPICS, MemoryManager } from './manager.js';
import { MemoryStore } from './store.js';

const memoryDir = process.env['NEOCLAW_MEMORY_DIR'] ?? join(homedir(), '.neoclaw', 'memory');
const store = new MemoryStore(join(memoryDir, 'index.sqlite'));
const manager = new MemoryManager(memoryDir, store);
manager.reindex();

const server = new Server(
  { name: 'neoclaw-memory', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_read',
      description:
        'Read the full content of a memory entry by id. Use memory_list to discover available ids.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: {
            type: 'string',
            description:
              'Memory entry id (e.g. "SOUL", "owner-profile", "preferences", or an episode id from memory_list)',
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'memory_search',
      description:
        'Full-text search across all memories (identity, knowledge, episodes). Returns up to 5 matches ranked by relevance. Each result includes id, title, category, date, tags, and content.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query text (supports FTS5 syntax)' },
          category: {
            type: 'string',
            enum: ['identity', 'episode', 'knowledge'],
            description: 'Filter results to a specific category',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'memory_save',
      description:
        'Save or overwrite a memory entry. For identity: writes to SOUL.md (id is always "SOUL"). For knowledge: writes to knowledge/{id}.md. Episodes cannot be written manually.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: {
            type: 'string',
            enum: Object.keys(KNOWLEDGE_TOPICS),
            description:
              'Memory entry id — must be one of the fixed knowledge slots: "owner-profile" (personal info), "preferences" (habits/workflow), "people" (contacts), "projects" (tech decisions), "notes" (misc). Ignored when category="identity".',
          },
          content: {
            type: 'string',
            description: 'Markdown content to save (without frontmatter)',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for categorization',
          },
          category: {
            type: 'string',
            enum: ['identity', 'knowledge'],
            description:
              'Target category. "identity" updates SOUL.md, "knowledge" (default) writes to knowledge/{id}.md',
          },
        },
        required: ['content'],
      },
    },
    {
      name: 'memory_list',
      description:
        'List all stored memory entries with their id, title, category, date, and tags. Use this to discover entry ids for memory_read.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          category: {
            type: 'string',
            enum: ['identity', 'episode', 'knowledge'],
            description: 'Filter to a specific category',
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  let result: string;
  switch (name) {
    case 'memory_read':
      result = await manager.handleRead(args ?? {});
      break;
    case 'memory_search':
      result = await manager.handleSearch(args ?? {});
      break;
    case 'memory_save':
      result = await manager.handleSave(args ?? {});
      break;
    case 'memory_list':
      result = await manager.handleList(args ?? {});
      break;
    default:
      result = `Unknown tool: ${name}`;
  }

  return { content: [{ type: 'text', text: result }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Memory MCP server failed to start:', err);
  process.exit(1);
});
