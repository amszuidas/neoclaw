/**
 * File access guard utility to prevent reading/writing sensitive files.
 */

import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';

export class FileAccessDenied extends Error {
  constructor(
    public readonly filePath: string,
    public readonly reason: string
  ) {
    super(`Access denied to ${filePath}: ${reason}`);
    this.name = 'FileAccessDenied';
  }
}

/**
 * Check if a file path is within the workspace directory.
 */
export function isPathInWorkspace(filePath: string, workspaceDir: string): boolean {
  const resolvedPath = resolve(filePath);
  const resolvedWorkspace = resolve(workspaceDir);
  // Use platform-specific separator to avoid prefix match issues
  // e.g., /workspace should not match /workspace2
  const workspaceWithSep = resolvedWorkspace + sep;
  return resolvedPath.startsWith(workspaceWithSep) || resolvedPath === resolvedWorkspace;
}

/**
 * Convert a glob pattern to a regular expression.
 * Supports *, **, ?, and character classes [a-z].
 */
function globToRegex(pattern: string): RegExp {
  const regexStr = pattern
    // Escape special regex characters
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // Replace glob wildcards with regex
    .replace(/\*\*/g, '☺☺☺') // Temp placeholder for **/
    .replace(/\*/g, '[^/]*') // Single * matches any non-slash characters
    .replace(/☺☺☺/g, '.*') // ** becomes .* (matches anything including slashes)
    .replace(/\?/g, '[^/]'); // ? matches any single non-slash character

  return new RegExp(`^${regexStr}$`);
}

/**
 * Check if a path matches a glob pattern.
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  // Expand ~ at the start
  const expandedPattern = pattern.replace(/^~/, homedir());

  // Convert pattern to regex
  const regex = globToRegex(expandedPattern);

  // Resolve the file path for consistent matching
  const resolvedPath = resolve(filePath);
  return regex.test(resolvedPath);
}

/**
 * Check if a file path matches any pattern in the blacklist.
 * Supports glob patterns and ~ expansion.
 */
export async function checkFileAccess(filePath: string, blacklist: string[]): Promise<void> {
  if (!blacklist || blacklist.length === 0) {
    return;
  }

  // Resolve and normalize the file path for consistent comparison
  const resolvedPath = resolve(filePath);

  // Check against each pattern
  for (const pattern of blacklist) {
    const expandedPattern = pattern.replace(/^~/, homedir());

    // Handle exact paths (no wildcards)
    if (pattern.indexOf('*') === -1 && pattern.indexOf('?') === -1 && pattern.indexOf('[') === -1) {
      const resolvedPattern = resolve(expandedPattern);

      // Check exact match
      if (resolvedPath === resolvedPattern) {
        throw new FileAccessDenied(filePath, `Path matches blacklist pattern: ${pattern}`);
      }

      // Check if the file is within a blacklisted directory
      // Ensure the pattern ends with a separator to avoid partial matches
      if (resolvedPath.startsWith(resolvedPattern + '/')) {
        throw new FileAccessDenied(filePath, `Path is within blacklisted directory: ${pattern}`);
      }
    } else {
      // Handle glob patterns
      if (matchesPattern(filePath, pattern)) {
        throw new FileAccessDenied(filePath, `Path matches blacklist pattern: ${pattern}`);
      }
    }
  }
}

/**
 * Middleware wrapper for file operations that checks access before execution.
 */
export function withFileGuard<T extends Array<any>, R>(
  blacklist: string[],
  fileArgIndex: number,
  fn: (...args: T) => R | Promise<R>
): (...args: T) => Promise<R> {
  return async (...args: T): Promise<R> => {
    const filePath = args[fileArgIndex];
    if (typeof filePath === 'string') {
      await checkFileAccess(filePath, blacklist);
    }
    return await fn(...args);
  };
}
