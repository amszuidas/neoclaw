/**
 * MessageBubble - Display a single message
 */

import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ThinkingPanel } from './ThinkingPanel';
import type { Message } from '../types';

interface MessageBubbleProps {
  message: Message;
  isLast?: boolean;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  const statsText = useMemo(() => {
    if (!message.stats) return null;
    const parts: string[] = [];
    if (message.stats.model) parts.push(message.stats.model);
    if (message.stats.elapsedMs != null)
      parts.push(`${(message.stats.elapsedMs / 1000).toFixed(1)}s`);
    if (message.stats.inputTokens != null) parts.push(`${message.stats.inputTokens} in`);
    if (message.stats.outputTokens != null) parts.push(`${message.stats.outputTokens} out`);
    if (message.stats.costUsd != null) parts.push(`$${message.stats.costUsd.toFixed(4)}`);
    return parts.length > 0 ? parts.join(' · ') : null;
  }, [message.stats]);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-3xl ${
          isUser
            ? 'bg-blue-600 text-white rounded-2xl rounded-tr-sm'
            : 'bg-gray-800 text-gray-100 rounded-2xl rounded-tl-sm'
        } px-4 py-3`}
      >
        {/* Thinking process panel */}
        {!isUser && message.thinking && <ThinkingPanel content={message.thinking} />}

        {/* Message content */}
        <div className="prose prose-invert max-w-none">
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <ReactMarkdown
              components={{
                code({ className, children, style: _style, ...props }) {
                  void _style;
                  const match = /language-(\w+)/.exec(className || '');
                  return match ? (
                    <SyntaxHighlighter
                      style={
                        vscDarkPlus as unknown as {
                          [key: string]: import('react').CSSProperties;
                        }
                      }
                      language={match[1]}
                      PreTag="div"
                    >
                      {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                  ) : (
                    <code className="bg-gray-700 px-1 py-0.5 rounded text-sm" {...props}>
                      {children}
                    </code>
                  );
                },
              }}
            >
              {message.content}
            </ReactMarkdown>
          )}
        </div>

        {/* Statistics */}
        {!isUser && statsText && (
          <div className="mt-3 pt-3 border-t border-gray-700">
            <p className="text-xs text-gray-400">{statsText}</p>
          </div>
        )}
      </div>
    </div>
  );
}
