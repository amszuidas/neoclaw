/**
 * WebSocket Hook for Local Gateway communication
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import type { Message, StreamEvent, ConnectionStatus } from '../types';

// Use relative path in development (via Vite proxy), direct connection in production
const isDev = import.meta.env.DEV;
const WS_URL = isDev
  ? `ws://${window.location.host}/ws`
  : `ws://${window.location.hostname}:3000/ws`;

// Storage keys for message persistence
const MESSAGES_STORAGE_KEY = (sessionId: string) => `neoclaw_messages_${sessionId}`;

export function useWebSocket(sessionId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const currentStreamRef = useRef<string | null>(null);
  const currentThinkingRef = useRef<string>('');

  // Load messages from localStorage when session changes
  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }

    const storageKey = MESSAGES_STORAGE_KEY(sessionId);
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Message[];
        setMessages(parsed);
      } catch (error) {
        console.error('Failed to load messages:', error);
        setMessages([]);
      }
    } else {
      // No stored messages for this session (new session), clear state
      setMessages([]);
    }
  }, [sessionId]);

  // Save messages to localStorage whenever they change
  useEffect(() => {
    if (!sessionId || messages.length === 0) return;

    const storageKey = MESSAGES_STORAGE_KEY(sessionId);
    localStorage.setItem(storageKey, JSON.stringify(messages));
  }, [sessionId, messages]);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setConnectionStatus('connecting');
      return;
    }

    setConnectionStatus('connecting');
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setConnectionStatus('connected');

      // Register the current session with the server immediately after connection
      if (sessionId) {
        ws.send(
          JSON.stringify({
            type: 'register',
            sessionId,
          })
        );
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      setConnectionStatus('disconnected');
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setConnectionStatus('disconnected');
    };

    ws.onmessage = (event) => {
      try {
        const serverMessage = JSON.parse(event.data);

        if (serverMessage.type === 'response') {
          // Non-streaming response
          const response = serverMessage.data as {
            text?: string;
            thinking?: string;
            model?: string;
            elapsedMs?: number;
            inputTokens?: number;
            outputTokens?: number;
            costUsd?: number;
          };

          setMessages((prev) => [
            ...prev,
            {
              id: `msg_${Date.now()}`,
              role: 'assistant' as const,
              content: response.text || '',
              thinking: response.thinking,
              timestamp: Date.now(),
              stats: {
                model: response.model,
                elapsedMs: response.elapsedMs,
                inputTokens: response.inputTokens,
                outputTokens: response.outputTokens,
                costUsd: response.costUsd,
              },
            },
          ]);
        } else if (serverMessage.type === 'stream_start') {
          // Start streaming response
          const streamId = `stream_${Date.now()}`;
          currentStreamRef.current = streamId;
          currentThinkingRef.current = '';

          setMessages((prev) => [
            ...prev,
            {
              id: streamId,
              role: 'assistant' as const,
              content: '',
              timestamp: Date.now(),
              isStreaming: true,
            },
          ]);
        } else if (serverMessage.type === 'stream_delta') {
          // Streaming delta update
          const event = serverMessage.data as StreamEvent;

          setMessages((prev) => {
            if (!currentStreamRef.current) return prev;

            const messageIndex = prev.findIndex((m) => m.id === currentStreamRef.current);
            if (messageIndex === -1) return prev;

            const message = prev[messageIndex];
            if (!message) return prev;
            const updated = { ...message };

            if (event.type === 'thinking_delta' && event.text) {
              currentThinkingRef.current += event.text;
              updated.thinking = currentThinkingRef.current;
            } else if (event.type === 'text_delta' && event.text) {
              updated.content = updated.content + event.text;
            } else if (event.type === 'done') {
              const response = event.response;
              if (response) {
                updated.content = response.text || updated.content;
                updated.stats = {
                  model: response.model,
                  elapsedMs: response.elapsedMs,
                  inputTokens: response.inputTokens,
                  outputTokens: response.outputTokens,
                  costUsd: response.costUsd,
                };
              }
              // Mark as not streaming when we get the done event
              updated.isStreaming = false;
              currentStreamRef.current = null;
              currentThinkingRef.current = '';
            }

            const newMessages = [...prev];
            newMessages[messageIndex] = updated;
            return newMessages;
          });
        } else if (serverMessage.type === 'stream_end') {
          // End streaming response (fallback, in case done event wasn't received)
          setMessages((prev) => {
            if (!currentStreamRef.current) return prev;

            const messageIndex = prev.findIndex((m) => m.id === currentStreamRef.current);
            if (messageIndex === -1) return prev;

            const newMessages = [...prev];
            const message = newMessages[messageIndex];
            if (!message) return prev;
            newMessages[messageIndex] = {
              ...message,
              isStreaming: false,
            };

            currentStreamRef.current = null;
            currentThinkingRef.current = '';

            return newMessages;
          });
        } else if (serverMessage.type === 'error') {
          console.error('Server error:', serverMessage.data);
        }
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    return () => {
      ws.close();
    };
  }, [sessionId]);

  const sendMessage = useCallback(
    (text: string) => {
      if (!wsRef.current || !sessionId || !isConnected) return;

      // Add user message
      setMessages((prev) => [
        ...prev,
        {
          id: `user_${Date.now()}`,
          role: 'user' as const,
          content: text,
          timestamp: Date.now(),
        },
      ]);

      // Send to server
      wsRef.current.send(
        JSON.stringify({
          type: 'message',
          sessionId,
          content: text,
        })
      );
    },
    [sessionId, isConnected]
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
    currentStreamRef.current = null;
    currentThinkingRef.current = '';
  }, []);

  return {
    messages,
    isConnected,
    sendMessage,
    clearMessages,
    connectionStatus,
  };
}
