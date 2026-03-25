/**
 * Session Manager for Local Gateway
 *
 * Manages chat sessions including creation, updates, listing, and deletion.
 */

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export class SessionManager {
  private _sessions = new Map<string, Session>();

  /**
   * Create a new session or update an existing one
   */
  createOrUpdate(sessionId: string, firstMessage: string): Session {
    let session = this._sessions.get(sessionId);

    if (!session) {
      session = {
        id: sessionId,
        title: this._generateTitle(firstMessage),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 1,
      };
      this._sessions.set(sessionId, session);
    } else {
      session.updatedAt = Date.now();
      session.messageCount++;
    }

    return session;
  }

  /**
   * Get a session by ID
   */
  get(sessionId: string): Session | undefined {
    return this._sessions.get(sessionId);
  }

  /**
   * List all sessions sorted by update time (newest first)
   */
  listAll(): Session[] {
    return Array.from(this._sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Delete a session by ID
   */
  delete(sessionId: string): void {
    this._sessions.delete(sessionId);
  }

  /**
   * Mark a session as disconnected (for WebSocket disconnection tracking)
   */
  disconnect(_sessionId: string): void {
    // Currently a no-op, but can be extended to track connection state
  }

  /**
   * Generate a title from the first message
   */
  private _generateTitle(firstMessage: string): string {
    // Use the first 30 characters of the first message as the title
    const trimmed = firstMessage.trim();
    return trimmed.length > 30 ? trimmed.slice(0, 30) + '...' : trimmed || 'New Chat';
  }
}
