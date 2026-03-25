/**
 * InputBox - Message input component
 */

import { useState, useRef, useEffect } from 'react';
import { Send, Paperclip } from 'lucide-react';

interface InputBoxProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  onTypingChange?: (isTyping: boolean) => void;
}

export function InputBox({ onSend, disabled, onTypingChange }: InputBoxProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Auto-resize textarea
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [text]);

  useEffect(() => {
    if (onTypingChange) {
      onTypingChange(text.length > 0);
    }
  }, [text, onTypingChange]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;

    onSend(trimmed);
    setText('');

    // Reset height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-gray-800 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-end gap-3 bg-gray-800 rounded-2xl p-3">
          <button
            className="p-2 hover:bg-gray-700 rounded-lg transition-colors"
            title="上传附件（暂不支持）"
            disabled
          >
            <Paperclip className="w-5 h-5 text-gray-400" />
          </button>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息... (Enter 发送，Shift+Enter 换行)"
            className="flex-1 bg-transparent resize-none outline-none text-gray-100 placeholder-gray-500 min-h-[24px] max-h-48 overflow-y-auto"
            disabled={disabled}
            rows={1}
          />

          <button
            onClick={handleSend}
            disabled={!text.trim() || disabled}
            className="p-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg transition-colors"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-2 text-center text-xs text-gray-500">
          AI 生成的内容可能不准确，请谨慎使用
        </div>
      </div>
    </div>
  );
}
