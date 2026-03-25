/**
 * Sidebar - Four-module navigation (Chat, Control, Agent, Settings)
 */

import { useState } from 'react';
import {
  MessageSquare,
  BarChart3,
  Link,
  Braces,
  FileText,
  Sun,
  Folder,
  Zap,
  Monitor,
  Settings,
  Bug,
  ScrollText,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { Session } from '../types';
import type { ConnectionStatus } from '../types';

interface SidebarProps {
  sessions: Session[];
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onSelectNavigation: (moduleKey: ModuleKey, itemKey: string, label: string) => void;
  activeNavigationKey: string | null;
  connectionStatus: ConnectionStatus;
  className?: string;
  onRequestClose?: () => void;
}

type ModuleKey = 'chat' | 'control' | 'agent' | 'settings';

interface Module {
  key: ModuleKey;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  items: ModuleItem[];
}

interface ModuleItem {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  type: 'session' | 'navigation';
}

const MODULES: Module[] = [
  {
    key: 'chat',
    title: '聊天',
    icon: MessageSquare,
    items: [
      // Session items will be dynamically added here
    ],
  },
  {
    key: 'control',
    title: '控制',
    icon: BarChart3,
    items: [
      { key: 'overview', label: '概览', icon: BarChart3, type: 'navigation' },
      { key: 'channels', label: '频道', icon: Link, type: 'navigation' },
      { key: 'instances', label: '实例', icon: Braces, type: 'navigation' },
      { key: 'sessions', label: '会话', icon: FileText, type: 'navigation' },
      { key: 'usage', label: '使用情况', icon: BarChart3, type: 'navigation' },
      { key: 'scheduled', label: '定时任务', icon: Sun, type: 'navigation' },
    ],
  },
  {
    key: 'agent',
    title: '代理',
    icon: Folder,
    items: [
      { key: 'agents', label: '代理', icon: Folder, type: 'navigation' },
      { key: 'skills', label: '技能', icon: Zap, type: 'navigation' },
      { key: 'nodes', label: '节点', icon: Monitor, type: 'navigation' },
    ],
  },
  {
    key: 'settings',
    title: '设置',
    icon: Settings,
    items: [
      { key: 'config', label: '配置', icon: Settings, type: 'navigation' },
      { key: 'debug', label: '调试', icon: Bug, type: 'navigation' },
      { key: 'logs', label: '日志', icon: ScrollText, type: 'navigation' },
    ],
  },
];

export function Sidebar({
  sessions,
  currentSessionId,
  onSelectSession,
  onSelectNavigation,
  activeNavigationKey,
  className,
  onRequestClose,
}: SidebarProps) {
  const [expandedModules, setExpandedModules] = useState<Set<ModuleKey>>(
    new Set(['chat', 'control', 'agent', 'settings'])
  );
  const [activeModule, setActiveModule] = useState<ModuleKey>('chat');

  const toggleModule = (moduleKey: ModuleKey) => {
    setExpandedModules((prev) => {
      const next = new Set(prev);
      if (next.has(moduleKey)) {
        next.delete(moduleKey);
      } else {
        next.add(moduleKey);
      }
      return next;
    });
  };

  const isModuleExpanded = (moduleKey: ModuleKey) => expandedModules.has(moduleKey);

  return (
    <div
      data-testid="dashboard-sidebar"
      className={`w-64 bg-white border-r border-gray-200 flex flex-col ${className ?? ''}`}
    >
      {/* Header */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-red-500 rounded-full flex items-center justify-center">
            <span className="text-white text-sm font-bold">N</span>
          </div>
          <h1 className="text-base font-bold text-gray-900">Gateway Dashboard</h1>
        </div>
      </div>

      {/* Navigation modules */}
      <div className="flex-1 overflow-y-auto">
        {MODULES.map((module) => {
          const isExpanded = isModuleExpanded(module.key);
          const isActive = activeModule === module.key;

          return (
            <div key={module.key} className="border-b border-gray-100">
              {/* Module header */}
              <div
                className={`flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors ${
                  isActive ? 'bg-pink-50' : ''
                }`}
                onClick={() => {
                  setActiveModule(module.key);
                  toggleModule(module.key);
                }}
              >
                <span
                  className={`text-sm font-medium ${isActive ? 'text-gray-900' : 'text-gray-700'}`}
                >
                  {module.title}
                </span>
                {isExpanded ? (
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                )}
              </div>

              {/* Module items */}
              {isExpanded && (
                <div className="bg-gray-50">
                  {module.key === 'chat' ? (
                    // Chat sessions
                    sessions.length === 0 ? (
                      <div className="px-4 py-3 text-sm text-gray-500 text-center">暂无会话</div>
                    ) : (
                      sessions.map((session) => (
                        <div
                          key={session.id}
                          className={`flex items-center gap-2 px-4 py-2 cursor-pointer transition-colors ${
                            currentSessionId === session.id
                              ? 'bg-pink-50 text-red-600'
                              : 'hover:bg-gray-100 text-gray-700'
                          }`}
                          onClick={() => {
                            onSelectSession(session.id);
                            setActiveModule('chat');
                            onRequestClose?.();
                          }}
                        >
                          <MessageSquare className="w-4 h-4 flex-shrink-0" />
                          <span className="text-sm flex-1 truncate">聊天</span>
                        </div>
                      ))
                    )
                  ) : (
                    // Navigation items
                    module.items.map((item) => {
                      const ItemIcon = item.icon;
                      const navKey = `${module.key}:${item.key}`;
                      const isNavActive = activeNavigationKey === navKey;
                      return (
                        <div
                          key={item.key}
                          className={`flex items-center gap-2 px-6 py-2 cursor-pointer transition-colors ${
                            isNavActive
                              ? 'bg-pink-50 text-red-600'
                              : 'hover:bg-gray-100 text-gray-700'
                          }`}
                          onClick={() => {
                            setActiveModule(module.key);
                            onSelectNavigation(module.key, item.key, item.label);
                            onRequestClose?.();
                          }}
                        >
                          <ItemIcon
                            className={`w-4 h-4 ${isNavActive ? 'text-red-500' : 'text-gray-500'}`}
                          />
                          <span className="text-sm">{item.label}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
