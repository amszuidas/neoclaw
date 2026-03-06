<div align="center">
  <h1><img src="imgs/logo.png" width="45" alt="Logo" /> NeoClaw</h1>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
    <img src="https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Bun-%23000000.svg?style=flat&logo=bun&logoColor=white" alt="Bun">
  </p>
  <p>
    NeoClaw 是一个基于 Gateway 架构设计的可扩展 AI 超级助手。<br/>
    目前支持将 <strong>飞书（Feishu/Lark）</strong> 作为消息网关，<strong>Claude Code</strong> 作为强大的 AI 后端。
  </p>
  <p>
    <strong>中文</strong> | <a href="README.md">English</a>
  </p>
  <img src="imgs/demo/identity.png" width="300" alt="Identity" />
</div>

## 📖 目录

- [功能特性](#-功能特性)
- [快速开始](#-快速开始)
  - [前置要求](#前置要求)
  - [安装依赖](#安装依赖)
  - [配置](#配置)
  - [启动服务](#启动服务)
  - [开发模式](#开发模式)
- [架构设计](#-架构设计)
- [定时任务 CLI](#-定时任务-cli)
- [MCP Servers 与 Skills](#-mcp-servers-与-skills)
- [记忆系统](#-记忆系统)
- [技术栈](#-技术栈)
- [目录结构](#-目录结构)
- [贡献指南](#-贡献指南)
- [许可证](#-许可证)

## ✨ 功能特性

- **完整 Claude Code 支持**: 由世界上最强大的 Agent 驱动，完美支持 Claude Code 的一切能力（包括 Plugins、Skills、MCPs 等），提供最强大的 AI 协作体验。

- **多场景支持**: 完美适配私聊、群聊、话题群等多种飞书场景。
  - **群聊支持**: 在群聊中 @NeoClaw 即可唤起回复。
    <br/><img src="imgs/demo/group.png" width="300" alt="Group Chat" />
  - **话题群支持**: 支持在话题群中同时进行多个话题的讨论。
    <br/><img src="imgs/demo/threads.jpeg" width="300" alt="Threads" />

- **流式响应**: 利用飞书卡片实现打字机效果的流畅输出。
  <br/><img src="imgs/demo/streaming.png" width="300" alt="Streaming" />

- **问题澄清**: 支持交互式问卷，利用 Claude Code 的 `AskUserQuestion` 工具主动澄清需求。
  <br/><img src="imgs/demo/form.png" width="300" alt="Form" />

- **多模态支持**: 支持飞书发送图片消息，Claude Code 可直接理解图片内容。
  <br/><img src="imgs/demo/image.png" width="300" alt="Image Understanding" />

- **工作区隔离**: 每个会话拥有独立的工作目录 (`~/.neoclaw/workspaces/<conversationId>`)

- **并发控制**: 每个会话拥有独立的加锁队列，确保消息按顺序处理，避免并发冲突。

- **定时任务**: 支持 Cron 表达式创建和管理定时任务。
  <br/><img src="imgs/demo/cron.png" width="300" alt="Cron Jobs" />

- **多层记忆系统**:
  - **全局记忆** (`MEMORY.md` / `SOUL.md`): 存储个人上下文、性格设定
  - **项目记忆** (`CLAUDE.md`): 每个工作区独立的上下文

- **自进化能力**: 支持通过对话让 NeoClaw 修改自身代码，并通过 `/restart` 命令重启生效，实现持续进化。

- **斜杠命令**:
  - `/clear`: 清除当前会话记忆
  - `/restart`: 重启服务
    <br/><img src="imgs/demo/restart.png" width="300" alt="Restart" />
  - `/status`: 查看当前状态
  - `/help`: 获取帮助信息

## 🚀 快速开始

### 前置要求

- [Bun](https://bun.sh) (v1.0+)
- **Claude Code**: 请参考 [Claude Code 安装说明](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) 进行安装和配置。
  > **注意**: 如果你不想订阅 Claude Code，可以通过配置 `~/.claude/settings.json` 来使用自定义 API：
  > ```json
  > {
  >   "env": {
  >     "ANTHROPIC_BASE_URL": "xxx",
  >     "ANTHROPIC_AUTH_TOKEN": "xxx",
  >     "ANTHROPIC_MODEL": "xxx",
  >     "ANTHROPIC_SMALL_FAST_MODEL": "xxx",
  >     "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
  >     "API_TIMEOUT_MS": "600000"
  >   }
  > }
  > ```
- 飞书开放平台账号及应用（需配置相应的权限和事件订阅），详细配置请参考 [飞书机器人配置指南](FEISHU_CONFIG.md)。

### 安装依赖

```bash
bun install
```

### 配置

1. 生成配置文件模板：

```bash
bun onboard
```

2. 编辑 `~/.neoclaw/config.json`：

> **提示**: 关于如何获取飞书应用的 `appId`、`appSecret` 等信息，请详细阅读 [飞书机器人配置指南](FEISHU_CONFIG.md)。

```jsonc
{
  "agent": {
    "type": "claude_code",
    "model": "claude-sonnet-4-6",  // 自定义 Claude 模型
    "systemPrompt": "",            // 自定义系统提示词
    "allowedTools": [],            // 允许的工具列表
    "timeoutSecs": 600             // 超时时间（秒）
  },
  "feishu": {
    "appId": "your_app_id",        // 飞书应用 App ID
    "appSecret": "your_app_secret",// 飞书应用 App Secret
    "verificationToken": "",       // 事件订阅 Verification Token
    "encryptKey": "",              // 事件订阅 Encrypt Key
    "domain": "feishu",            // "feishu" 或 "lark"
    "groupAutoReply": []           // 自动回复的群聊ID列表
  },
  "mcpServers": {                  // MCP Servers（新进程启动时热加载）
    "example-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@example/mcp-server"]
    }
  },
  "skillsDir": "~/.neoclaw/skills",// Skills 目录
  "logLevel": "info",
  "workspacesDir": "~/.neoclaw/workspaces"
}
```

### 启动服务

```bash
bun start
```

服务将自动守护进程化，后台运行，日志输出到 `~/.neoclaw/logs/neoclaw.log`。

### 开发模式

```bash
bun run dev
```

监听文件变化并自动重启，适合开发调试。

## 🏗️ 架构设计

采用 Gateway 模式，分离 I/O 适配和 AI 处理，保证系统的灵活性和可扩展性：

```mermaid
graph TD
    Gateway["Gateway (飞书 WebSocket)"] --> Dispatcher
    Dispatcher["Dispatcher (消息路由、会话管理)"] --> Agent
    Agent["Agent (Claude Code CLI)"]
```

### 核心组件

- **Gateway**: 消息平台适配器，负责处理飞书 WebSocket 连接、消息解析、卡片渲染。
- **Dispatcher**: 消息路由器，管理会话队列、处理斜杠命令、协调 Agent 工作。
- **Agent**: AI 后端封装，通过 Claude Code CLI 的 JSONL 流协议进行通信。
- **CronScheduler**: 定时任务调度器，支持复杂的定时任务管理。

### 消息流程

1. **接收**: Gateway 接收飞书消息事件，解析为 `InboundMessage`。
2. **初始化**: 创建 `reply` 闭包和 `streamHandler` 闭包。
3. **调度**: Dispatcher 获取会话锁，防止并发处理冲突。
4. **执行**: 检查斜杠命令，若无则调用 `Agent.stream()` 或 `Agent.run()`。
5. **反馈**: 流式事件通过 `streamHandler` 实时推送至 Gateway 进行卡片渲染。

## ⏰ 定时任务 CLI

NeoClaw 内置强大的定时任务管理功能：

```bash
# 创建一次性任务
neoclaw-cron create --message "任务描述" --run-at "2024-03-01T09:00:00+08:00"

# 创建循环任务 (周一至周五 09:00)
neoclaw-cron create --message "任务描述" --cron-expr "0 9 * * 1-5"

# 列出所有任务
neoclaw-cron list

# 删除任务
neoclaw-cron delete --job-id <jobId>

# 更新任务
neoclaw-cron update --job-id <jobId> [--label "新名称"] [--enabled true|false]
```

## 🔌 MCP Servers 与 Skills

NeoClaw 支持在统一层面配置 MCP Servers 和 Skills，配置会自动翻译为底层 Agent（如 Claude Code）所需的格式。

### MCP Servers

在 `~/.neoclaw/config.json` 的 `mcpServers` 字段中添加 MCP 服务器：

```jsonc
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "env": { "API_KEY": "xxx" }
    },
    "remote-server": {
      "type": "http",
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer xxx" }
    }
  }
}
```

MCP 配置在每次新 Claude Code 进程启动时**热加载**自配置文件，无需重启 daemon。

### Skills

将 Skill 目录放置在 `~/.neoclaw/skills/` 下（可通过 `skillsDir` 或 `NEOCLAW_SKILLS_DIR` 环境变量自定义路径）。每个 Skill 目录必须包含 `SKILL.md` 文件：

```
~/.neoclaw/skills/
  deploy/
    SKILL.md
  code-review/
    SKILL.md
```

Skills 在新进程启动时自动同步到各工作区：新增的 Skill 会被链接，已删除的 Skill 会被清理，修改 `SKILL.md` 内容会立即生效（通过符号链接）。

## 🧠 记忆系统

NeoClaw 拥有两层记忆系统，模拟人类的长期记忆与短期工作记忆：

### 全局记忆 (Long-term Memory)

位于 `~/.neoclaw/memory/`：
- `MEMORY.md`: 记录主人的个人上下文、工作背景、首要事项等。
- `SOUL.md`: 定义 NeoClaw 的性格、价值观、沟通风格。

### 项目记忆 (Contextual Memory)

位于每个工作区目录下的 `CLAUDE.md` 或 `AGENTS.md`，用于存储特定项目或会话的上下文信息。

### 记忆读取规则

- **新会话**: 自动读取当前工作区的项目记忆。
- **主人 (zuidas)**: 若发起者为主人，同时读取全局记忆。
- **其他用户**: 仅访问项目记忆，保护全局隐私。

### 记忆更新规则

- **通用**: 所有聊天都会更新项目记忆。
- **主人**: 主人的聊天内容会同时更新项目记忆和全局记忆。
- **自动维护**: 支持通过定时任务每天凌晨 4 点自动整理和更新全局记忆。

## 📚 技术栈

- **Runtime**: [Bun](https://bun.sh) (高性能 JavaScript 运行时)
- **Language**: TypeScript (Strict Mode)
- **SDK**: `@larksuiteoapi/node-sdk`
- **Linting**: ESLint + Prettier

## 📂 目录结构

```
neoclaw/
├── src/
│   ├── agents/           # AI Agent 实现 (Claude Code)
│   ├── cli/              # CLI 工具 (Cron 管理)
│   ├── cron/             # 定时任务核心逻辑
│   ├── gateway/          # 消息网关适配器
│   │   └── feishu/       # 飞书适配器具体实现
│   ├── templates/        # 记忆与配置模板
│   ├── utils/            # 通用工具函数
│   ├── config.ts         # 配置管理
│   ├── daemon.ts         # 守护进程逻辑
│   ├── dispatcher.ts     # 消息分发核心
│   └── index.ts          # 程序入口
├── CLAUDE.md             # Claude Code 指南
└── package.json
```

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建新的分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 📄 许可证

本项目基于 [Apache-2.0](LICENSE) 协议开源。
