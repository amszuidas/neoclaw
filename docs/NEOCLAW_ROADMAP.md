# NeoClaw · Workspace & Agent Teams Roadmap

> 版本：v0.1-draft · 状态：**公开征集贡献者**

---

## 一、现状分析（基于 main 分支）

### 当前架构

```
Gateway (Feishu/WeCom WebSocket)
    └─ Dispatcher (session 锁队列 + slash 命令)
        └─ Agent (Claude Code CLI 单进程)
            └─ Workspace (~/.neoclaw/workspaces/<conversationId>/)
```

### 关键现有能力（可复用）

| 模块              | 当前实现                     | 对新方向的价值                    |
| ----------------- | ---------------------------- | --------------------------------- |
| `dispatcher.ts`   | 会话队列 + 单 Agent 调度     | → 升级为 Leader dispatch 核心     |
| `src/agents/`     | Claude Code CLI 封装         | → 抽象为 Worker Agent 基类        |
| Workspace 隔离    | 每个 conversationId 一个目录 | → 升级为有元数据的 Workspace 实体 |
| Memory MCP Server | 三层记忆 + SQLite FTS5       | → Team 共享 knowledge 层          |
| Skills 系统       | SKILL.md 符号链接注入        | → 角色化 Skills（per-role）       |
| CronScheduler     | 定时任务                     | → 异步 Task 触发入口              |

### 核心缺口

- 无 **多 Agent 并行**编排能力
- Workspace 是纯文件目录，无结构化元数据
- Agent 之间无通信协议
- 无任务分解（task decomposition）层
- Leader 角色与 Worker 角色没有概念区分

---

## 二、目标范式：Workspace + Agent Teams

### 设计原则

1. **Leader only dispatches**：Leader Agent 只负责意图理解 → 任务拆解 → 派发，不执行具体工作
2. **Workspace 是一等公民**：每个 Workspace 有身份、成员、任务列表、共享上下文
3. **Worker 按角色专化**：每个 Worker Agent 绑定角色（Coder / Researcher / Reviewer / Planner 等）
4. **消息总线解耦**：Leader ↔ Worker 通过内部消息队列通信，不直接调用
5. **Gateway 无感知**：用户侧体验不变，变化在内部调度层

### 目标架构

```
Gateway (Feishu / WeCom / Dashboard)
    └─ Dispatcher v2
        └─ Workspace Manager
            ├─ Workspace { id, meta, taskQueue, sharedContext }
            │   ├─ Leader Agent  ← 接收用户消息，输出 TaskPlan
            │   │     └─ TaskPlanner (拆解 + 派发)
            │   ├─ Worker Agent [role=coder]    ← 消费 Task
            │   ├─ Worker Agent [role=researcher]
            │   └─ Worker Agent [role=reviewer]
            └─ AgentRegistry (角色注册 + 能力声明)
```

### 核心数据流

```
用户消息
  → Dispatcher 路由到 Workspace
  → Leader Agent 接收 → 生成 TaskPlan[]
  → TaskQueue.push(tasks)
  → WorkerPool 按角色认领 Task
  → Worker 执行 → 写结果到 sharedContext
  → Leader 聚合结果 → 回复用户
```

---

## 三、Roadmap

### Phase 0 · 基础设施准备（Breaking ground）

**目标**：为后续特性建立无破坏性的扩展点，现有功能不受影响

| ID   | 任务                                                                                                                   | 难度   | 优先级 |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| P0-1 | **Workspace 元数据层**：给现有 workspace 目录增加 `.neoclaw/workspace.json`（id, name, createdAt, mode: `solo\|team`） | ⭐⭐   | P0     |
| P0-2 | **Agent 基类抽象**：将 `src/agents/claude_code.ts` 重构为 `BaseAgent` + `ClaudeCodeAgent implements BaseAgent`         | ⭐⭐⭐ | P0     |
| P0-3 | **AgentRole 枚举 & 配置 schema**：在 config.json 增加 `teams` 字段，定义角色列表                                       | ⭐     | P0     |
| P0-4 | **内部事件总线**：实现轻量 `EventBus`（pub/sub），用于 Leader ↔ Worker 解耦通信                                        | ⭐⭐⭐ | P0     |
| P0-5 | **测试框架搭建**：Bun test + 关键路径集成测试，防止重构回归                                                            | ⭐⭐   | P0     |

---

### Phase 1 · Workspace v2（Workspace as Entity）

**目标**：Workspace 从目录升级为有生命周期的实体

| ID   | 任务                                                                                             | 难度   | 优先级 |
| ---- | ------------------------------------------------------------------------------------------------ | ------ | ------ |
| P1-1 | **WorkspaceManager**：CRUD workspace，支持命名（`/ws new "项目名"`）、切换、列举                 | ⭐⭐⭐ | P1     |
| P1-2 | **SharedContext**：workspace 级共享文件空间，所有 Agent 可读写 `shared/` 目录                    | ⭐⭐   | P1     |
| P1-3 | **Workspace slash 命令**：`/ws new`, `/ws list`, `/ws switch <name>`, `/ws info`                 | ⭐⭐   | P1     |
| P1-4 | **Workspace 生命周期 Hooks**：`onWorkspaceCreate`, `onWorkspaceResume`，用于初始化 Skills/Memory | ⭐⭐   | P1     |
| P1-5 | **Dashboard UI 更新**：在 Dashboard Gateway 展示 workspace 列表和状态                            | ⭐⭐⭐ | P2     |

---

### Phase 2 · Task System（任务层）

**目标**：建立结构化任务流转机制，是 Agent Teams 的血管

| ID   | 任务                                                                                      | 难度     | 优先级 |
| ---- | ----------------------------------------------------------------------------------------- | -------- | ------ |
| P2-1 | **Task 数据结构**：`{ id, type, role, input, output, status, parentTaskId }`，存入 SQLite | ⭐⭐     | P1     |
| P2-2 | **TaskQueue**：per-workspace 任务队列，支持优先级、依赖关系（DAG）                        | ⭐⭐⭐⭐ | P1     |
| P2-3 | **TaskPlanner**：Leader Agent 的输出解析器，将自然语言 plan 转为 `Task[]`                 | ⭐⭐⭐⭐ | P1     |
| P2-4 | **Task 状态机**：`pending → assigned → running → done/failed`，支持重试                   | ⭐⭐⭐   | P2     |
| P2-5 | **Task 结果聚合**：Leader 读取 Worker 输出，合并为用户可见回复                            | ⭐⭐⭐   | P2     |

---

### Phase 3 · Agent Teams（多 Agent 编排）

**目标**：核心特性，Leader + Worker 分工协作

| ID   | 任务                                                                            | 难度       | 优先级 |
| ---- | ------------------------------------------------------------------------------- | ---------- | ------ |
| P3-1 | **LeaderAgent**：专用系统 Prompt（只做分解 & 派发），不执行工具调用             | ⭐⭐⭐     | P1     |
| P3-2 | **WorkerAgent**：绑定角色，接收 Task，独立 workspace 子目录执行                 | ⭐⭐⭐⭐   | P1     |
| P3-3 | **AgentRegistry**：注册角色能力（`{ role, skills, mcpServers, systemPrompt }`） | ⭐⭐⭐     | P1     |
| P3-4 | **WorkerPool**：并发控制，多 Worker 同时执行不同 Task，结果写回 SharedContext   | ⭐⭐⭐⭐   | P2     |
| P3-5 | **Team 模式配置**：`config.json` 支持 `teams` 定义，按 workspace 开启 team 模式 | ⭐⭐       | P2     |
| P3-6 | **跨 Agent 通信**：Worker 可请求 Leader 澄清、或调用其他 Worker 的能力          | ⭐⭐⭐⭐⭐ | P3     |

---

### Phase 4 · 用户体验打磨

**目标**：让 team 协作对用户透明、可观测

| ID   | 任务                                                                                              | 难度     | 优先级 |
| ---- | ------------------------------------------------------------------------------------------------- | -------- | ------ |
| P4-1 | **进度可视化**：Feishu 卡片展示 `[Leader] → [Coder ✓] [Researcher...] [Reviewer pending]`         | ⭐⭐⭐   | P2     |
| P4-2 | **`/team` 命令**：`/team status`, `/team log`, `/team abort`                                      | ⭐⭐     | P2     |
| P4-3 | **团队记忆隔离**：team workspace 的 memory 按角色分层，Worker 的 episode 归入 workspace knowledge | ⭐⭐⭐   | P3     |
| P4-4 | **审批节点**：Leader 可设置人工介入点（`requireApproval`），在 Feishu 弹出确认卡片                | ⭐⭐⭐⭐ | P3     |

---

## 四、众包贡献工作流

参考 **RFC + Good First Issue + 功能分支** 模式，适合主理人精力有限、贡献者分散的场景。

### 4.1 分支命名约定

```
feat/P0-2-base-agent-abstraction
feat/P1-1-workspace-manager
fix/workspace-slash-command-crash
docs/contributing-guide
```

### 4.2 Issue 标签体系

| 标签                  | 含义                         |
| --------------------- | ---------------------------- |
| `phase:0` ~ `phase:4` | 所属 Phase                   |
| `role:core`           | 影响核心架构，需主理人审核   |
| `role:feature`        | 功能扩展，可独立贡献         |
| `good first issue`    | 适合新贡献者，无架构依赖     |
| `blocked:P0-2`        | 依赖其他 Issue 完成          |
| `help wanted`         | 主理人已设计好接口，需要实现 |
| `RFC`                 | 需要社区讨论设计方案         |

### 4.3 贡献流程（SOP）

```
1. 认领
   └─ 在对应 Issue 下评论 "I'll take this"
       └─ 主理人分配 Assignee，打 `in progress`

2. 开发
   └─ fork → 创建 feat/Pxx-xxx 分支
       └─ 遵循 src/ 现有模块边界
       └─ 新增 Bun test（P0-5 建立后要求）

3. PR
   └─ 标题格式：[P1-1] WorkspaceManager: CRUD + slash commands
       └─ 描述模板（见下）
       └─ 自我 Review checklist

4. 审核
   └─ core 类 PR → 主理人审核
   └─ feature 类 PR → 1 位其他贡献者 review 即可合并
```

### 4.4 PR 描述模板

```markdown
## 关联 Issue

closes #XX

## 改动范围

- src/workspace/manager.ts (新增)
- src/dispatcher.ts (修改：注入 WorkspaceManager)

## 测试

- [ ] 现有测试全部通过
- [ ] 新增测试覆盖核心路径

## 破坏性变更

- [ ] 无
- [ ] 有（描述：...）

## 自测截图 / 日志

（粘贴飞书截图或终端日志）
```

### 4.5 RFC 流程（大型变更）

Phase 2 TaskQueue、Phase 3 多 Agent 编排等涉及架构的 Issue，需先走 RFC：

1. 在 `docs/rfcs/` 下提交 `RFC-xxx-task-queue.md`
2. Issue 标记 `RFC`，开放 7 天讨论
3. 主理人 approve 后，RFC 状态改为 `accepted`，拆分为具体 feat Issue

### 4.6 推荐的 GitHub Project 看板结构

```
Backlog → RFC Review → Ready to Claim → In Progress → Review → Done
```

---

## 五、推荐直接引入的现有方案

| 需求                | 推荐方案                                                           | 理由                                   |
| ------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| Leader 任务拆解协议 | **Claude Code 的 `TodoWrite/TodoRead` tool**                       | 已内置，可直接作为 TaskPlan 载体       |
| 多 Agent 进程并发   | **Bun Worker threads** 或独立子进程（已有 Claude Code 子进程模式） | 复用现有 subprocess 模式，不引入新依赖 |
| Agent 间通信总线    | **Node EventEmitter（Bun 兼容）**                                  | 零依赖，够用；后续可升级为 BullMQ      |
| Task 持久化         | **现有 SQLite（memory index.sqlite 扩展）**                        | 复用基础设施，加 tasks 表即可          |
| 进度卡片渲染        | **现有 Feishu 流式卡片机制**                                       | 已有 streaming card，改内容即可        |
| 贡献者工作流        | **GitHub Projects + Issue Templates**                              | 成熟，0 学习成本                       |

---

## 六、推荐的第一批 Good First Issues

适合新贡献者的低风险入门任务（Phase 0，无架构依赖）：

1. **`P0-3`** · 在 config schema 增加 `teams[]` 字段定义（纯类型 + 配置解析，不改逻辑）
2. **`P0-5`** · 搭建 Bun test 框架 + 为 dispatcher 现有 slash 命令写测试
3. **`docs`** · 补充中文 CONTRIBUTING.md（翻译 + 贡献流程）
4. **`P1-3`** · 实现 `/ws` slash 命令解析（参考现有 `/clear`, `/restart` 实现模式）

---

## 七、里程碑时间线（参考）

```
M1 (Phase 0 完成)  → 架构稳定，可并行多人开发
M2 (Phase 1 完成)  → Workspace 作为产品特性对外发布
M3 (Phase 2 完成)  → Task 系统可用，内测 team 模式
M4 (Phase 3 完成)  → Agent Teams 公测
M5 (Phase 4 完成)  → 正式版 v1.0
```

---

_本 Roadmap 由主理人维护，欢迎通过 Issue 讨论调整优先级。_
_认领任务请直接在对应 Issue 下留言。_
