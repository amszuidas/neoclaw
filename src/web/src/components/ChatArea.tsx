/**
 * ChatArea - Main chat interface area
 */

import { useRef, useEffect } from 'react';
import { Menu } from 'lucide-react';
import { MessageList } from './MessageList';
import { InputBox } from './InputBox';
import type { Message } from '../types';

interface ChatAreaProps {
  sessionId: string | null;
  messages: Message[];
  onSendMessage: (text: string) => void;
  isConnected: boolean;
  onOpenMenu?: () => void;
}

export function ChatArea({
  sessionId,
  messages,
  onSendMessage,
  isConnected,
  onOpenMenu,
}: ChatAreaProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!sessionId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900">
        <div className="text-center text-gray-500">
          <p className="text-lg mb-2">👋 欢迎使用 NeoClaw</p>
          <p>从侧边栏选择一个会话或创建新会话开始聊天</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-gray-900">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="打开菜单"
            data-testid="mobile-menu-button"
            className="md:hidden p-2 rounded-lg border border-gray-700 text-gray-200 hover:bg-gray-800"
            onClick={onOpenMenu}
          >
            <Menu className="w-5 h-5" />
          </button>
          <h1 className="text-lg font-semibold text-gray-100">NeoClaw</h1>
        </div>
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              isConnected ? 'bg-green-500' : 'bg-red-500'
            }`}
          />
          <span className="text-sm text-gray-400">
            {isConnected ? '已连接' : '未连接'}
          </span>
        </div>
      </header>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto">
        <MessageList messages={messages} />
        <div ref={messagesEndRef} />
      </div>

      {/* Input box */}
      <InputBox
        onSend={onSendMessage}
        disabled={!isConnected}
      />
    </div>
  );
}
