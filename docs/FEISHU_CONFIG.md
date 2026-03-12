# 飞书机器人配置指南

本文档将指导你如何在飞书开放平台创建并配置 NeoClaw 所需的机器人应用。

## 1. 创建应用

1. 登录 [飞书开放平台](https://open.feishu.cn/app)。
2. 点击“创建企业自建应用”，填写应用名称（例如：NeoClaw）和描述。

## 2. 添加机器人能力

进入应用详情页，在左侧菜单选择 **“添加应用能力”** -> **“机器人”**，点击“添加”。

<img src="../imgs/config/robot.png" width="600" alt="添加机器人能力" />

## 3. 配置权限

NeoClaw 需要一系列权限才能正常工作（如读取消息、发送消息、上传图片等）。

1. 进入 **“开发配置”** -> **“权限管理”**。
2. 点击页面上的 **“批量导入权限”** 粘贴并开通以下权限点。

```json
{
  "scopes": {
    "tenant": [
      "cardkit:card:write",
      "contact:user.employee_id:readonly",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly"
    ],
    "user": []
  }
}
```

<img src="../imgs/config/permissions.png" width="600" alt="权限配置" />

## 4. 获取凭证

进入 **“基础信息”** -> **“凭证与基础信息”**，找到 **App ID** 和 **App Secret**。

<img src="../imgs/config/app_info.png" width="600" alt="应用凭证" />

将这两个值复制并填入 NeoClaw 的配置文件 `~/.neoclaw/config.json` 中（通过 `bun onboard` 生成）：

```jsonc
"feishu": {
    "appId": "cli_...",        // 你的 App ID
    "appSecret": "...",        // 你的 App Secret
    // ...
}
```

## 5. 配置事件与回调

NeoClaw 通过 WebSocket 长连接接收飞书事件，因此通常不需要配置公网 Request URL，但需要在后台开启事件订阅。

1. 启动 NeoClaw 服务（`bun start` 或 `bun run dev`）。
2. 进入 **“开发配置”** -> **“事件与回调”**。
3. 参考下图配置事件与回调。

<img src="../imgs/config/event_config.png" width="600" alt="事件订阅配置" />

<img src="../imgs/config/recall_config.png" width="600" alt="回调配置" />

## 6. 发布应用

完成以上配置后，进入 **“应用发布”** -> **“版本管理与发布”**。

1. 创建一个版本（例如 v1.0.0）。
2. 申请发布。
3. 等待企业管理员审核通过（如果是自建应用，管理员通常可以在飞书管理后台直接审核）。

审核通过后，你的 NeoClaw 机器人即可在飞书客户端中被搜索和使用了！
