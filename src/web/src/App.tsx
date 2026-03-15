/**
 * App - Main application component
 */

import { useEffect, useState } from 'react';
import { Menu } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { useWebSocket } from './hooks/useWebSocket';
import { useSessions } from './hooks/useSessions';
import './styles/globals.css';

function App() {
  const [activeNavigation, setActiveNavigation] = useState<{
    key: string;
    label: string;
  } | null>(null);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  const {
    sessions,
    currentSessionId,
    selectSession,
    updateSession,
  } = useSessions();

  const { messages, isConnected, sendMessage, connectionStatus } =
    useWebSocket(currentSessionId);

  const handleSelectSession = (sessionId: string) => {
    setActiveNavigation(null);
    setIsMobileSidebarOpen(false);
    selectSession(sessionId);
  };

  const handleSelectNavigation = (moduleKey: string, itemKey: string, label: string) => {
    setActiveNavigation({
      key: `${moduleKey}:${itemKey}`,
      label,
    });
    setIsMobileSidebarOpen(false);
  };

  // Handle send message
  const handleSendMessage = (text: string) => {
    sendMessage(text);
  };

  // Update session info when messages change
  useEffect(() => {
    if (!currentSessionId || messages.length === 0) return;

    // Update message count and timestamp
    updateSession(currentSessionId, {
      messageCount: messages.length,
      updatedAt: Date.now(),
    });
  }, [currentSessionId, messages, sessions, updateSession]);

  return (
    <div className="flex h-screen bg-gray-900 text-gray-100">
      <div
        className={`md:hidden fixed inset-0 z-40 bg-black/40 transition-opacity ${
          isMobileSidebarOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={() => setIsMobileSidebarOpen(false)}
      />

      <Sidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onSelectNavigation={handleSelectNavigation}
        activeNavigationKey={activeNavigation?.key ?? null}
        connectionStatus={connectionStatus}
        className={`fixed md:static top-0 left-0 h-full z-50 transform transition-transform md:translate-x-0 ${
          isMobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        } md:flex`}
        onRequestClose={() => setIsMobileSidebarOpen(false)}
      />

      {activeNavigation ? (
        <div className="flex-1 flex flex-col bg-gray-900">
          <header className="flex items-center gap-3 px-6 py-4 border-b border-gray-800">
            <button
              type="button"
              aria-label="打开菜单"
              data-testid="mobile-menu-button"
              className="md:hidden p-2 rounded-lg border border-gray-700 text-gray-200 hover:bg-gray-800"
              onClick={() => setIsMobileSidebarOpen(true)}
            >
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-lg font-semibold text-gray-100">{activeNavigation.label}</h1>
          </header>

          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-gray-300 px-6">
              <h2 className="text-2xl font-semibold mb-3">{activeNavigation.label}</h2>
              <p className="text-gray-400">
                {activeNavigation.label} 页面正在开发中，已成功响应侧边栏点击。
              </p>
            </div>
          </div>
        </div>
      ) : (
        <ChatArea
          sessionId={currentSessionId}
          messages={messages}
          onSendMessage={handleSendMessage}
          isConnected={isConnected}
          onOpenMenu={() => setIsMobileSidebarOpen(true)}
        />
      )}
    </div>
  );
}

export default App;
