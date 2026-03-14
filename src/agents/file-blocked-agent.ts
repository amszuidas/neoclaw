/**
 * File-blacklist-aware agent wrapper.
 *
 * Wraps an Agent and adds file access validation to tool calls.
 * For group chats, additionally restricts write operations (delete, modify, create)
 * on files outside the workspace directory.
 */

import { checkFileAccess, FileAccessDenied, isPathInWorkspace } from '../utils/file-guard.js';
import { logger } from '../utils/logger.js';
import type { Agent, AgentStreamEvent, RunRequest, RunResponse } from './types.js';

const log = logger('file-blocked-agent');

/**
 * Check if a bash command contains write operations and validate file paths.
 * Group chats cannot write to (delete, modify, create) files outside the workspace directory.
 */
function checkGroupChatWriteRestrictions(
  bashCommand: string,
  chatType: 'private' | 'group' | undefined,
  workspaceDir: string | undefined
): void {
  // Only apply restrictions to group chats
  if (chatType !== 'group') {
    log.debug(`Skip group chat restriction: chatType=${chatType}`);
    return;
  }

  if (!workspaceDir) {
    log.warn('Workspace directory not configured, skipping group chat file write check');
    return; // No workspace directory configured, skip check
  }

  // Check if command contains write operations
  const writePatterns = [
    /\brm\s+/, // rm - delete files
    /\brmdir\s+/, // rmdir - remove directories
    />\s*\S/, // > or >| - overwrite redirect
    />>\s*\S/, // >> - append redirect
    /\bmv\s+/, // mv - move/rename files
    /\bcp\s+/, // cp - copy (could create new files outside workspace)
    /\btouch\s+/, // touch - create files
    /\bmkdir\s+/, // mkdir - create directories
    /\bchmod\s+/, // chmod - modify permissions
    /\bchown\s+/, // chown - change owner
    /\bln\s+/, // ln - create symlinks (could escape workspace)
    /\btee\s+\S/, // tee - write to files
  ];

  let hasWriteCommand = false;
  for (const pattern of writePatterns) {
    if (pattern.test(bashCommand)) {
      hasWriteCommand = true;
      break;
    }
  }

  if (!hasWriteCommand) {
    return; // Not a write command
  }

  log.info(`Group chat write command detected: ${bashCommand.substring(0, 100)}`);

  // Extract file paths from the command
  const paths = extractFilePathsFromBash(bashCommand);
  log.info(`Extracted ${paths.length} paths from write command: ${JSON.stringify(paths)}`);

  if (paths.length === 0) {
    log.warn(
      `No paths extracted from write command, blocking for safety: ${bashCommand.substring(0, 100)}`
    );
    // Cannot safely validate the command, so block it
    throw new FileAccessDenied(
      bashCommand.substring(0, 50),
      `Could not validate file paths in write command for group chat. For security reasons, complex write commands must be explicitly validated.`
    );
  }

  for (const path of paths) {
    if (!isPathInWorkspace(path, workspaceDir)) {
      log.warn(`Blocking write operation on file outside workspace: ${path}`);
      throw new FileAccessDenied(
        path,
        `Group chats are not allowed to write to files outside the workspace directory`
      );
    }
  }
}

/**
 * Extract file paths from tool use events.
 */
function extractFilePathsFromToolUse(event: {
  type: 'tool_use';
  name: string;
  input: unknown;
}): string[] {
  const paths: string[] = [];
  const { name, input } = event;

  if (typeof input !== 'object' || input === null) return paths;

  switch (name) {
    case 'Read':
      if ('file_path' in input && typeof input.file_path === 'string') {
        paths.push(input.file_path);
      }
      break;

    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      if ('file_path' in input && typeof input.file_path === 'string') {
        paths.push(input.file_path);
      }
      break;

    case 'Bash':
      if ('command' in input && typeof input.command === 'string') {
        const cmd = input.command;
        const extractedPaths = extractFilePathsFromBash(cmd);
        paths.push(...extractedPaths);
      }
      break;

    case 'Glob':
      if ('pattern' in input && typeof input.pattern === 'string') {
        paths.push(input.pattern);
      }
      break;
  }

  return paths;
}

/**
 * Extract file paths from bash commands.
 * Handles quoted paths, variables, and common shell patterns.
 */
function extractFilePathsFromBash(command: string): string[] {
  const paths: string[] = [];

  // Remove comments from command
  const commandWithoutComments = command.replace(/#.*/g, '');

  // Extract paths with robust parsing
  const patterns = [
    // Redirection patterns (>, >>, <)
    /(?:^|[\s&|;])([<>]{1,2})\s*(['"]?)([^\s&|;]+?)\2/g,

    // Command patterns with explicit paths
    /(?:^|[\s&|;])(?:cat|less|more|head|tail|view|vim|vi|nano|code|open|xdg-open)\s+(?:--?\S+\s+)*?(['"]?)([^\s&|;]+?)\1/g,

    // File system commands (including rm)
    /(?:^|[\s&|;])(?:cd|ls|rm|cp|mv|test|\[|\[\[)\s+(?:--?\S+\s+)*?(['"]?)([^\s&|;]+?)\1/g,

    // Find patterns
    /(?:^|[\s&|;])find\s+[^\s&|;]+?\s+-name\s+(['"]?)([^\s&|;]+?)\1/g,

    // Grep patterns with file arguments
    /(?:^|[\s&|;])grep\s+(?:-[^\s&|;]+\s+)*?(['"]?)([^\s&|;]+?)\1/g,
  ];

  for (const pattern of patterns) {
    let match;
    // Reset regex state
    pattern.lastIndex = 0;
    while ((match = pattern.exec(commandWithoutComments)) !== null) {
      // Extract the path (capture group 2 or 3 depending on pattern)
      const path = match[3] || match[2];
      if (path && path.length > 0 && !path.startsWith('-')) {
        // Basic variable expansion for common environment variables
        const expandedPath = path
          .replace(/\$HOME|~/g, process.env.HOME || '')
          .replace(/\$PWD/g, process.cwd())
          .replace(/\$USER/g, process.env.USER || '');

        paths.push(expandedPath);
      }
    }
  }

  // Also check for suspicious patterns that might indicate file access
  const suspiciousPatterns = [
    /\b(cat|view|read|tail|head)\s+\S*\.env\S*/gi,
    /\b(cat|view|read)\s+\S*credential\S*/gi,
    /\b(cat|view|read)\s+\S*secret\S*/gi,
    /\b(cat|view|read)\s+\/etc\//gi,
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(commandWithoutComments)) {
      // Extract the suspicious path
      const match = commandWithoutComments.match(pattern);
      if (match) {
        const pathMatch = match[0].match(/\S+$/);
        if (pathMatch) {
          paths.push(pathMatch[0]);
        }
      }
    }
  }

  return [...new Set(paths)]; // Deduplicate
}

/**
 * Sanitize a file path for logging to avoid exposing sensitive information.
 * Keeps the filename and directory structure but removes potential sensitive tokens.
 */
function sanitizePathForLog(filePath: string): string {
  // If the path contains obvious sensitive patterns, redact them
  const sensitivePatterns = [
    /\/[^/]*credential[^/]*\//gi,
    /\/[^/]*secret[^/]*\//gi,
    /\/[^/]*password[^/]*\//gi,
    /\/[^/]*token[^/]*\//gi,
    /\/\.[^/]*env[^/]*$/gi,
  ];

  let sanitized = filePath;
  for (const pattern of sensitivePatterns) {
    sanitized = sanitized.replace(pattern, '/[REDACTED]/');
  }

  return sanitized;
}

/**
 * Wrap an agent to enforce file access policies.
 */
export function createFileBlockedAgent(
  baseAgent: Agent,
  blacklist: string[],
  workspaceDir?: string
): Agent {
  const hasBlacklist = blacklist && blacklist.length > 0;

  if (hasBlacklist) {
    log.info(`File blacklist enabled with ${blacklist.length} rules`);
  }

  if (workspaceDir) {
    log.info(`Group chat file write restrictions enabled for workspace: ${workspaceDir}`);
  }

  return {
    kind: baseAgent.kind,

    async run(request: RunRequest): Promise<RunResponse> {
      // For non-streaming mode, we validate file paths from the request text before execution
      // This is a best-effort check as we can't intercept tool calls during execution
      try {
        const chatType = request.extra?.chatType as 'private' | 'group' | undefined;

        // Check if the request text contains suspicious file paths (only if blacklist is configured)
        if (hasBlacklist) {
          const pathsFromText = extractFilePathsFromBash(request.text);
          for (const filePath of pathsFromText) {
            await checkFileAccess(filePath, blacklist);
          }
        }

        // Check group chat write restrictions (always enabled if workspaceDir is set)
        checkGroupChatWriteRestrictions(request.text, chatType, workspaceDir);

        // Execute the base agent
        return await baseAgent.run(request);
      } catch (error) {
        if (error instanceof FileAccessDenied) {
          const sanitizedPath = sanitizePathForLog(error.filePath);
          log.warn(`File access blocked in non-streaming mode: ${sanitizedPath} - ${error.reason}`);

          // Return a text response explaining the block
          return {
            text: `⚠️ **Security Warning**: Access to \`${sanitizedPath}\` was blocked because it matches a blacklist pattern.`,
          };
        }

        // Re-throw unexpected errors
        throw error;
      }
    },

    async *stream(request: RunRequest): AsyncGenerator<AgentStreamEvent> {
      // Intercept tool_use events and validate file paths
      const chatType = request.extra?.chatType as 'private' | 'group' | undefined;

      // Check if base agent supports streaming
      if (!baseAgent.stream) {
        // If base agent doesn't support streaming, fall back to run()
        const response = await baseAgent.run(request);
        yield { type: 'done', response };
        return;
      }

      for await (const event of baseAgent.stream(request)) {
        if (event.type === 'tool_use') {
          log.debug(`Intercepted tool_use: ${event.name}`);
          try {
            const filePaths = extractFilePathsFromToolUse(event);
            log.debug(`Extracted file paths: ${filePaths.join(', ')}`);

            // Check blacklist only if configured
            if (hasBlacklist) {
              for (const filePath of filePaths) {
                await checkFileAccess(filePath, blacklist);
              }
            }

            // Check group chat write restrictions for Bash commands
            // If this check fails, we throw an error and skip yielding the tool_use event
            if (event.name === 'Bash' && typeof event.input === 'object' && event.input !== null) {
              const command = (event.input as { command: string }).command;
              if (typeof command === 'string') {
                checkGroupChatWriteRestrictions(command, chatType, workspaceDir);
              }
            }

            // Check group chat write restrictions for Write/Edit tools
            if (
              chatType === 'group' &&
              (event.name === 'Write' || event.name === 'Edit' || event.name === 'NotebookEdit') &&
              workspaceDir
            ) {
              const filePath = (event.input as { file_path: string }).file_path;
              if (typeof filePath === 'string' && !isPathInWorkspace(filePath, workspaceDir)) {
                log.warn(`Blocking ${event.name} operation on file outside workspace: ${filePath}`);
                throw new FileAccessDenied(
                  filePath,
                  `Group chats are not allowed to write to files outside the workspace directory`
                );
              }
            }

            // All checks passed, allow the tool call
            yield event;
          } catch (error) {
            if (error instanceof FileAccessDenied) {
              const sanitizedPath = sanitizePathForLog(error.filePath);
              log.warn(`File access blocked: ${sanitizedPath} - ${error.reason}`);

              // Skip the tool_use event entirely and replace with an error message
              // This prevents the agent from executing the blocked operation
              yield {
                type: 'text_delta',
                text: `\n\n⚠️ **Security Warning**: Access to \`${sanitizedPath}\` was blocked. ${error.reason}\n`,
              };
            } else {
              // Unexpected error, allow the tool call
              log.error('Error checking file access:', error);
              yield event;
            }
          }
        } else {
          // Not a tool_use event, pass through
          yield event;
        }
      }
    },

    healthCheck(): Promise<boolean> {
      return baseAgent.healthCheck();
    },

    clearConversation(conversationId: string): Promise<void> {
      return baseAgent.clearConversation(conversationId);
    },

    dispose(): Promise<void> {
      return baseAgent.dispose();
    },
  };
}
