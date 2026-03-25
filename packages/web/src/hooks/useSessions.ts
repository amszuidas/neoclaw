/**
 * Session management hook
 */

import { useState, useCallback, useEffect } from 'react';
import type { Session } from '../types';

const SESSIONS_STORAGE_KEY = 'neoclaw_sessions';
const MESSAGES_STORAGE_PREFIX = 'neoclaw_messages_';
const LAST_SESSION_ID_KEY = 'neoclaw_last_session_id';

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  // Load sessions from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Session[];

        // Sort by updatedAt descending (newest first)
        const sorted = parsed.sort((a, b) => b.updatedAt - a.updatedAt);
        setSessions(sorted);

        // Try to restore the last selected session, otherwise use the most recent one
        const lastSessionId = localStorage.getItem(LAST_SESSION_ID_KEY);
        const sessionIdToSelect =
          lastSessionId && sorted.find((s) => s.id === lastSessionId)
            ? lastSessionId
            : (sorted[0]?.id ?? null);

        if (sessionIdToSelect) {
          setCurrentSessionId(sessionIdToSelect);
        }
      } catch (error) {
        console.error('Failed to load sessions:', error);
      }
    } else {
      // No sessions in storage, create an initial one
      const newSession: Session = {
        id: `session_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        title: 'NeoClaw Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
      };
      setSessions([newSession]);
      setCurrentSessionId(newSession.id);
    }
  }, []); // Only run once on mount

  // Save last selected session ID whenever it changes
  useEffect(() => {
    if (currentSessionId) {
      localStorage.setItem(LAST_SESSION_ID_KEY, currentSessionId);
    }
  }, [currentSessionId]);

  // Save sessions to localStorage whenever they change
  useEffect(() => {
    if (sessions.length > 0) {
      localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
    }
  }, [sessions]);

  const updateSession = useCallback((sessionId: string, updates: Partial<Session>) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId ? { ...session, ...updates, updatedAt: Date.now() } : session
      )
    );
  }, []);

  const deleteSession = useCallback(
    (sessionId: string) => {
      // Delete messages from localStorage
      const messagesKey = `${MESSAGES_STORAGE_PREFIX}${sessionId}`;
      localStorage.removeItem(messagesKey);

      setSessions((prev) => prev.filter((session) => session.id !== sessionId));

      // If we deleted the current session, switch to another one
      if (sessionId === currentSessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        if (remaining[0]) {
          setCurrentSessionId(remaining[0].id);
        } else {
          setCurrentSessionId(null);
        }
      }
    },
    [currentSessionId, sessions]
  );

  const selectSession = useCallback((sessionId: string) => {
    setCurrentSessionId(sessionId);
  }, []);

  return {
    sessions,
    currentSessionId,
    updateSession,
    deleteSession,
    selectSession,
    setCurrentSessionId,
  };
}
