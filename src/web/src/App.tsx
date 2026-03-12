/**
 * App - Main application component
 */

import { useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { useWebSocket } from './hooks/useWebSocket';
import { useSessions } from './hooks/useSessions';
import './styles/globals.css';

function App() {
  const {
    sessions,
    currentSessionId,
    deleteSession,
    selectSession,
    updateSession,
  } = useSessions();

  const { messages, isConnected, sendMessage, connectionStatus } =
    useWebSocket(currentSessionId);

  // Handle send message
  const handleSendMessage = (text: string) => {
    sendMessage(text);
  };

  // Update session info when messages change
  useEffect(() => {
    if (!currentSessionId || messages.length === 0) return;

    const currentSession = sessions.find(s => s.id === currentSessionId);

    // Update message count and timestamp
    updateSession(currentSessionId, {
      messageCount: messages.length,
      updatedAt: Date.now(),
    });
  }, [currentSessionId, messages, sessions, updateSession]);

  return (
    <div className="flex h-screen bg-gray-900 text-gray-100">
      {/* Sidebar */}
      <Sidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={selectSession}
        connectionStatus={connectionStatus}
      />

      {/* Chat area */}
      <ChatArea
        sessionId={currentSessionId}
        messages={messages}
        onSendMessage={handleSendMessage}
        isConnected={isConnected}
      />
    </div>
  );
}

export default App;
