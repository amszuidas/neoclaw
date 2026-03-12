/**
 * ThinkingPanel - Collapsible panel for showing AI thinking process
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Brain } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface ThinkingPanelProps {
  content: string;
}

export function ThinkingPanel({ content }: ThinkingPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="mb-3 border border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-750 hover:bg-gray-700 transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-gray-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray-400" />
        )}
        <Brain className="w-4 h-4 text-purple-400" />
        <span className="text-sm font-medium text-gray-300">思考过程</span>
      </button>

      {isExpanded && (
        <div className="px-3 py-2 bg-gray-800 text-sm text-gray-400 max-h-96 overflow-y-auto">
          <ReactMarkdown className="prose prose-sm prose-invert">
            {content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
