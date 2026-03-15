import { join } from 'node:path';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';

import { loadConfig, McpServerConfig } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Callback that writes the final MCP server map into an agent workspace directory.
 * The format and target filename are agent-specific (e.g. `.mcp.json` for Claude Code,
 * `opencode.json` for Opencode), so each agent supplies its own implementation.
 */
export type WriteMcpConfig = (cwd: string, servers: Record<string, McpServerConfig>) => void;

/** Values sourced directly from NeoClawConfig — what the user has configured. */
type WorkspaceConfig = {
  /** Base directory under which per-conversation subdirectories are created. */
  workspacesDir?: string | null;
  /** Fallback MCP server map used when the config file cannot be read. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Source directory containing skill subdirectories (each must contain a SKILL.md). */
  skillsDir?: string | null;
};

/** Agent-specific behaviour — how the workspace files should be written. */
type WorkspaceStrategy = {
  /**
   * Writes the MCP server config into the workspace in the format the agent expects.
   * Called once per `prepareWorkspace` invocation.
   */
  writeMcpConfig: WriteMcpConfig;
  /**
   * Relative path inside the workspace where skill symlinks are placed.
   * e.g. `'.claude/skills'` for Claude Code, `'.opencode/skills'` for Opencode.
   */
  agentSkillsDir: string;
};

const log = logger('workspace-manager');

/**
 * Manages per-conversation workspace directories for AI agents.
 *
 * Responsibilities (called once per new subprocess / session):
 * 1. Create `<workspacesDir>/<conversationId>/` on demand.
 * 2. Write agent-specific MCP server config (hot-reloaded from the config file on
 *    every call so changes take effect without a daemon restart).
 * 3. Sync skill symlinks: create missing, update changed targets, remove stale ones.
 *
 * The two agent-specific differences (MCP file format and skills subdirectory) are
 * injected via `WorkspaceStrategy` so this class stays agent-agnostic.
 */
export class WorkspaceManager {
  constructor(
    private readonly _config: WorkspaceConfig,
    private readonly _strategy: WorkspaceStrategy
  ) {}

  /**
   * Create and prepare the workspace directory for the given conversation.
   * - Writes agent-specific MCP server config (hot-reloaded from config file).
   * - Syncs skill symlinks (create new, update changed, remove stale).
   * Returns the workspace path, or undefined if no workspacesDir is configured.
   */
  prepareWorkspace(conversationId: string): string | undefined {
    if (!this._config.workspacesDir) return;

    // Sanitize conversationId for use as a directory name (replace ':' with '_')
    const dirName = conversationId.replace(/:/g, '_');
    const dir = join(this._config.workspacesDir, dirName);

    mkdirSync(dir, { recursive: true });

    // Sync configuration for agent
    // Writes agent-specific MCP server config (hot-reloaded from config file).
    this._syncMcpServers(dir);
    // Syncs skill symlinks (create new, update changed, remove stale).
    this._syncSkills(dir);

    return dir;
  }

  /** Re-read mcpServers from config file on each call so changes take effect without daemon restart. */
  private _syncMcpServers(cwd: string): void {
    let mcpServers: Record<string, McpServerConfig> | undefined;

    try {
      mcpServers = loadConfig().mcpServers;
    } catch {
      mcpServers = this._config.mcpServers;
    }

    const createBuiltinMemoryServer = (): McpServerConfig => {
      const memoryDir = join(homedir(), '.neoclaw', 'memory');
      const mcpServerScript = new URL('../memory/mcp-server.ts', import.meta.url).pathname;

      return {
        type: 'stdio',
        command: 'bun',
        args: ['run', mcpServerScript],
        env: { NEOCLAW_MEMORY_DIR: memoryDir },
      };
    };

    const allServers: Record<string, McpServerConfig> = {
      ...mcpServers,
      // Always inject the built-in memory MCP server alongside user-configured servers.
      'neoclaw-memory': createBuiltinMemoryServer(),
    };

    this._strategy.writeMcpConfig(cwd, allServers);
  }

  /** Sync skill symlinks into agentSkillsDir: create new, update changed, remove stale. */
  private _syncSkills(cwd: string): void {
    const skillsDir = this._config.skillsDir;
    if (!skillsDir || !existsSync(skillsDir)) return;

    const destSkillsDir = join(cwd, this._strategy.agentSkillsDir);
    mkdirSync(destSkillsDir, { recursive: true });

    let srcEntries: string[];
    try {
      srcEntries = readdirSync(skillsDir);
    } catch {
      return;
    }

    const validSkills = new Set<string>();
    for (const name of srcEntries) {
      const srcSkill = join(skillsDir, name);
      try {
        if (!lstatSync(srcSkill).isDirectory()) continue;
        if (!existsSync(join(srcSkill, 'SKILL.md'))) continue;
      } catch {
        continue;
      }
      validSkills.add(name);

      const destLink = join(destSkillsDir, name);
      try {
        if (lstatSync(destLink).isSymbolicLink()) {
          if (readlinkSync(destLink) === srcSkill) continue; // already correct
          unlinkSync(destLink); // target changed, re-create
        } else {
          continue; // real dir/file exists, don't overwrite
        }
      } catch {
        // destLink doesn't exist — will create below
      }

      try {
        symlinkSync(srcSkill, destLink);
        log.info(`Linked skill "${name}" → ${destLink}`);
      } catch (err) {
        log.warn(`Failed to symlink skill "${name}": ${err}`);
      }
    }

    // Remove stale symlinks that no longer correspond to a valid skill
    let destEntries: string[];
    try {
      destEntries = readdirSync(destSkillsDir);
    } catch {
      return;
    }
    for (const name of destEntries) {
      if (validSkills.has(name)) continue;
      const destLink = join(destSkillsDir, name);
      try {
        if (!lstatSync(destLink).isSymbolicLink()) continue;
        unlinkSync(destLink);
        log.info(`Removed stale skill symlink "${name}" from ${destSkillsDir}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
