/**
 * File-blacklist-aware agent wrapper.
 *
 * Wraps an Agent and adds file access validation to tool calls.
 */

import { checkFileAccess, FileAccessDenied } from '@neoclaw/core/utils/file-guard';
import { logger } from '@neoclaw/core/utils/logger';
import type { Agent, AgentStreamEvent, RunRequest, RunResponse } from '@neoclaw/core';

const log = logger('file-blocked-agent');

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
export function createFileBlockedAgent(baseAgent: Agent, blacklist: string[]): Agent {
  if (!blacklist || blacklist.length === 0) {
    // No blacklist configured, return base agent as-is
    return baseAgent;
  }

  log.info(`File blacklist enabled with ${blacklist.length} rules`);

  return {
    kind: baseAgent.kind,

    async run(request: RunRequest): Promise<RunResponse> {
      try {
        const pathsFromText = extractFilePathsFromBash(request.text);
        for (const filePath of pathsFromText) {
          await checkFileAccess(filePath, blacklist);
        }

        return await baseAgent.run(request);
      } catch (error) {
        if (error instanceof FileAccessDenied) {
          const sanitizedPath = sanitizePathForLog(error.filePath);
          log.warn(`File access blocked in non-streaming mode: ${sanitizedPath} - ${error.reason}`);

          return {
            text: `⚠️ **Security Warning**: Access to \`${sanitizedPath}\` was blocked because it matches a blacklist pattern.`,
          };
        }

        throw error;
      }
    },

    async *stream(request: RunRequest): AsyncGenerator<AgentStreamEvent> {
      if (!baseAgent.stream) {
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

            for (const filePath of filePaths) {
              await checkFileAccess(filePath, blacklist);
            }

            yield event;
          } catch (error) {
            if (error instanceof FileAccessDenied) {
              const sanitizedPath = sanitizePathForLog(error.filePath);
              log.warn(`File access blocked: ${sanitizedPath} - ${error.reason}`);

              yield {
                type: 'text_delta',
                text: `\n\n⚠️ **Security Warning**: Access to \`${sanitizedPath}\` was blocked. ${error.reason}\n`,
              };
            } else {
              log.error('Error checking file access:', error);
              yield event;
            }
          }
        } else {
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
