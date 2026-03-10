# 企业微信智能助手（API 模式）配置指南

本文介绍如何使用企业微信**智能助手（长连接模式）**接入 NeoClaw。

## 什么是智能助手（长连接模式）？

智能助手是企业微信官方提供的**机器人接入方式**，通过 WebSocket 长连接实现双向通信。

### 与其他方式对比

| 特性           | 企业应用模式     | 群机器人 (Webhook) | **智能助手（长连接）**     |
| -------------- | ---------------- | ------------------ | -------------------------- |
| **配置难度**   | 高（需回调 URL） | 低（只需 key）     | **中（需 Bot ID/Secret）** |
| **服务器要求** | 需公网服务器     | 无需服务器         | **无需服务器**             |
| **消息接收**   | ✅ 完整支持      | ❌ 不支持          | **✅ 完整支持**            |
| **消息发送**   | ✅ 完整支持      | ✅ 基础功能        | **✅ 完整支持**            |
| **主动推送**   | ✅ 支持          | ✅ 支持            | **✅ 支持**                |
| **长连接**     | ❌ HTTP 回调     | ❌ HTTP 请求       | **✅ WebSocket**           |
| **流式响应**   | ✅ 支持          | ❌ 不支持          | **⚠️ 需适配**              |

---

## 创建智能助手

### 步骤 1: 创建机器人

1. 登录[企业微信]客户端
2. 侧边栏点击 **工作台**，搜索 **智能机器人**，点击 **创建机器人**
   <br/><img src="imgs/demo/wework-0.png" width="600" alt="Streaming" />
3. 选择 **手动创建**
   <br/><img src="imgs/demo/wework-1.png" width="600" alt="Streaming" />

4. 拉到最低，选择 **API 模式创建**
   <br/><img src="imgs/demo/wework-2.png" width="600" alt="Streaming" />
   ![alt text](image.png)
5. 选择 **长连接方式**，创建完成后，会显示：

- **Bot ID**: 类似 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
- **Secret**: 类似 `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
  <br/><img src="imgs/demo/wework-3.png" width="600" alt="Streaming" />

---

## 配置 NeoClaw

编辑 `~/.neoclaw/config.json`:

```jsonc
{
  "wework": {
    "botId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "secret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  },
}
```

---

## 启动服务

```bash
bun start
```

启动后会自动：

1. 获取 access_token
2. 建立 WebSocket 长连接
3. 启动心跳保持连接
4. 开始接收消息

---

## 使用方式

### 单聊

1. 在企业微信中找到"NeoClaw"机器人
2. 发送消息：**你好**
3. 收到 AI 回复

### 群聊

1. 将 NeoClaw 机器人添加到群聊
2. **@机器人** 发送消息
3. 收到 AI 回复

---

## 功能特性

### ✅ 支持的功能

- **文本消息** - 发送和接收文本
- **Markdown** - 富文本格式（标题、列表、代码块等）
- **图片消息** - 支持图片识别（Claude Vision）
- **文件消息** - 支持文件传输
- **主动推送** - 可主动向用户发送消息

### ⚠️ 限制

1. **流式响应**：需要适配（长连接模式暂不支持流式卡片）
2. **交互式表单**：需要使用 Markdown 格式化问题列表
3. **频率限制**：每分钟最多 **1000 条**消息
