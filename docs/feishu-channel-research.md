# DSH 飞书频道插件研究 —— 架构分析与 hermes-agent 参考对照

> 研究对象：
> - **DSH**：`@deepseek-ai/dsh`（Cordis 插件系统），以及本地已有的 `dsh-feishu` 表面插件。
> - **hermes-agent**：`nousresearch/hermes-agent` 的飞书适配器（`plugins/platforms/feishu/adapter.py` 及配套文档，已摘录到 `_hermes_research/`）。
>
> 结论速览：DSH **没有**内置飞书适配器，飞书接入需要以"表面(surface) bundle"插件的方式自研。参考 hermes 的能力面可以补齐 `dsh-feishu` 的工程化短板；但两者架构差异很大——hermes 是"一个自研 Agent 框架 + 网关适配器"，DSH 是"复用官方 Agent 核心，外部写一个薄表面层"，**DSH 侧无需重写 Agent，只需把飞书协议翻译成 DSH 的会话/Agent API**。

---

## 1. DSH 如何实现"频道/表面"插件

### 1.1 表面 bundle 机制（cordis.patch.yml）

DSH 没有暴露给外部频道的"通用网关"抽象，它的接入点叫**表面(surface)**——一个 Cordis **bundle 补丁层**，叠在 `dsh-base` 之上，替换掉浏览器/Web 宿主，让外部输入直接驱动 Agent。

官方有两个可参照的表面：
- `@deepseek-ai/dsh-headless`：一次性任务模式（`dsh --profile headless "<task>"`）。
- `@deepseek-ai/dsh-web-app`：浏览器 GUI。

`dsh-headless` 的 `cordis.patch.yml` 结构（`dsh-feishu` 完全照抄了这一套）：

```yaml
- id: system-prompt      # 改 persona
  config: { persona: "You are a coding agent powered by the {{model}} model..." }
- id: hmr
  disabled: true          # 长驻服务关掉模块热重载
- id: tools
  config: { mode: !!js process.env.DSH_TOOLS_MODE }
- insert:
    - id: code-runtime        # Code Mode 是核心执行能力，不是 Web 组件
      name: '@deepseek-ai/dsh-code-runtime-worker-thread'
    - id: feishu-startup      # 解析命令行 → 发布 feishuStartup 服务
      name: '@tunging/dsh-feishu/startup'
    - id: feishu-runner       # 主插件，inject feishuStartup
      name: '@tunging/dsh-feishu'
      inject: [feishuStartup]
      config: { appId: !!js ctx.feishuStartup.appId, ... }
```

**关键设计**：`startup` 用 Commander 解析 CLI 后，通过 `ctx.provide(FEISHU_STARTUP_SERVICE, {...})` 发布一个普通 Cordis 服务；`runner` 用 `inject: [feishuStartup]` + `config: { appId: !!js ctx.feishuStartup.appId }` 的**懒求值 config** 读取它。这避免了跨插件直接传参，符合 DSH 的"provider → consumer"惯例。

### 1.2 Agent 驱动 API（dsh-agent）

DSH 外部表面驱动 Agent 的核心 API（均已在本机 `dsh-agent` 源码确认存在）：

| API | 说明 | 用途 |
|---|---|---|
| `ctx.agents.create({ sessionId, meta, agentOptions, setup })` | 通过核心注册表新建 Agent + Session | 每个飞书 chat 建一个 Agent |
| `agent.followup(createUserMessage({...}))` | 投递一条用户消息并唤醒 driver | 把飞书文本塞进 Agent |
| `agent.steer(createUserMessage({...}))` | 投递 steering（不新建 turn 边界） | 把"审批/澄清"回复给正在跑的 turn |
| `agent.whenIdle()` | 等待 turn 收敛到 idle | 一次性场景等待完成 |
| `agent.ctx.on("session/event", ...)` | 订阅该 Agent 的会话事件流 | **回复流回的正确姿势**（见下） |
| `installModelSelection(agentCtx, { current, assembled })` | 装配模型选择 | 让新 Agent 用默认模型 |

新建 Agent 的标准套路（`dsh-headless` 与 `dsh-feishu` 一致）：

```js
const selection = ctx.get("agentDefaultModel").currentSelection();
const handle = await ctx.get("agents").create({
  sessionId: SessionId(`feishu-${chatId}-${randomUUID()}`),
  meta: { cwd: config.workspaceRoot },
  agentOptions: { provider: selection.provider, model: selection.model },
  setup: (agentCtx) => installModelSelection(agentCtx, { current: selection, assembled: void 0 }),
});
```

### 1.3 回复流回的正确订阅方式 ⚠️

这是本次研究发现**当前 `dsh-feishu` 最大的 bug**。

DSH 的 `Session` 类（`dsh-session/lib/index.js`）**没有 `.on()` 方法**。它的方法只有 `append / deriveMessages / events / seq / requestHeader / requestContext` 等。会话事件是通过 Cordis 事件 `"session/event"` 发布的：

```js
// dsh-session 内部（append 时）
collectSessionCallbacks(entry.emitCtx, [entry.carrier, "session/event", ...])
invokeContainedSessionObservers(entry.emitCtx, "session/event", entry.id, callbackArgs, ...)
```

DSH 全仓库里所有消费者（`dsh-session-title`、`dsh-goal`、`dsh-session-projection-cache`、`dsh-token-meter`、`dsh-host-apiproxy`… 共 22 处）统一用：

```js
ctx.on("session/event", (session, event) => { ... })
```

在根 context 订阅会收到**所有** Agent 的事件，所以要么按 `session.id === holder.agent.session.id` 过滤，要么在 `agent.ctx`（Agent 作用域 context）上订阅只收本 Agent 的。

而当前 `dsh-feishu/lib/index.js` 的 `ChatAgent.attach()` 写的是：

```js
this.agent.session.on("event", (ev) => { ... })   // ❌ Session 没有 on()，会抛 TypeError
```

**这会直接崩**。应改为（在 runner 的 `ctx` 上订阅并过滤，或对 `agent.ctx` 订阅）：

```js
// 方案 A：根 ctx 订阅 + 按 session 过滤（推荐，runner 内一次注册）
ctx.on("session/event", (session, event) => {
  if (session.id !== holder.agent.session.id) return;
  if (event.type === "assistant/message") { ...流回飞书... }
});

// 方案 B：Agent 作用域订阅（更精确，随 Agent 生命周期自动清理）
holder.agent.ctx.on("session/event", (session, event) => { ... });
```

### 1.4 会话持久化 / 续聊

- 一次性：`agent.whenIdle()` → `ctx.sessions.flush(agent.session)`（见 headless）。
- 长驻续聊：`ctx.agents.resume({ resumeSessionId, meta, agentOptions, setup })`（`dsh-agent` 源码 `resume(options)` 已确认存在）。`dsh-feishu` README 已规划"chat_id → sessionId"映射表持久化，但**尚未实现**。
- Session 本身由 `dsh-session-persistence` 插件负责落盘；表面层要保证 `resumeSessionId` 稳定可复用。

---

## 2. 当前 `dsh-feishu` 实现分析

目录与代码已通读（`lib/index.js`、`lib/startup.js`、`lib/types/*.d.ts`、`cordis.patch.yml`、`package.json`）。

**已实现 / 结构正确**：
- ✅ 表面 bundle 结构完全对齐 `dsh-headless` 官方范式。
- ✅ `startup`（Commander 解析 appId/appSecret/mode/port/workspace）→ `provide` → runner `inject` 的链路正确。
- ✅ webhook（HTTP 事件订阅 + `url_verification` challenge 应答）+ longconn（`client.wsClient.start()` 长连接）双通道。
- ✅ 用 `@larksuiteoapi/node-sdk`，每 chat 一个独立 DSH 会话（`Map<chat_id, ChatAgent>`）。
- ✅ 文本分片发送、错误写 stderr。

**Bug / 缺口**：
- ✅ **`agent.session.on("event")` 崩溃 bug 已修复**（见 1.3 与 P0）：改为 `ctx.on("session/event", ...)` + `bySession` 反向路由。
- ⚠️ 只处理 `text` 消息：飞书 post/图片/文件/语音等 `message_type` 全被忽略。
- ⚠️ 无群 @ 提及门控：群消息不 @ 机器人也会触发，可能被滥用。
- ⚠️ 无用户 allowlist：任何能触达 bot 的人都能用。
- ⚠️ 无 markdown→post 富文本渲染（agent 输出 markdown 会以纯文本发出，体验差）。
- ⚠️ 无审批交互：DSH 的 `ask`/审批事件不会转成飞书卡片。
- ⚠️ 无去重（飞书 webhook 可能重投）；无 webhook 签名校验 / 限流。
- ⚠️ 无会话持久化：重启后 `chat_id` 映射丢失，历史会话无法恢复。

---

## 3. hermes-agent 飞书实现解析（参考）

### 3.1 适配器模型

hermes 的飞书是**网关插件**（`plugins/platforms/feishu/`），核心是 `FeishuAdapter(BasePlatformAdapter)`，通过 `register(ctx)` → `ctx.register_platform()` 注册，**零侵入核心代码**。其插件声明（`plugin.yaml`）声明了 `requires_env`/`optional_env`，驱动 CLI 配置向导。

适配器职责（与 DSH 表面层的本质差异）：hermes 是"**Agent 框架自己实现了会话/工具/审批**，适配器只负责协议翻译 + 调用 `self.handle_message(event)` 交给网关"。DSH 恰好相反——**Agent 核心是现成的，表面层只做"飞书协议 ↔ DSH 会话 API"的翻译**，工作量更小。

### 3.2 FeishuAdapter 能力矩阵（对照 `_hermes_research/...feishu.md`）

| 能力 | hermes 实现 | DSH 表面层对应物 |
|---|---|---|
| 双通道 | websocket / webhook（`FEISHU_CONNECTION_MODE`） | ✅ `dsh-feishu` 已有 mode: longconn/webhook |
| 群门控 | 群必须 @ 机器人才响应；`FEISHU_GROUP_POLICY`=open/allowlist/disabled | ❌ 需补 |
| 用户鉴权 | `FEISHU_ALLOWED_USERS` open_id 白名单；群内也按发送者查 | ❌ 需补 |
| 媒体收发 | 图片/音/视频/文件上传下载、缓存 | ❌ 需补（`im.resource` 权限） |
| 富文本 | markdown 自动转 `post`+`md`，失败降级纯文本 | ❌ 需补 |
| 审批/澄清 | `send_clarify` / `send_exec_approval` 渲染成卡片按钮，回调路由回工具 | ❌ 需补（对应 DSH 的 `ask`/审批） |
| 去重 | message_id 24h TTL 去重 | ❌ 需补 |
| 限流/安全 | webhook 签名校验、限流、异常跟踪、body 上限 | ❌ 需补 |
| 防循环 | 过滤 bot 自己的消息 / bot-to-bot | ❌ 需补 |
| 打字状态 | `Typing` reaction，完成后清除/`CrossMark` | ❌ 可选 |
| 批处理 | 文本/媒体突发合并（debounce） | ❌ 可选 |
| 文档评论 / 会议 | `drive.notice.comment_add_v1` / `vc.bot.meeting_invited_v1` | 扩展，非核心 |
| 会话隔离 | 群内 per-user 会话（`group_sessions_per_user`） | ⚠️ DSH 目前每 chat 一个，未区分群内用户 |

---

## 4. 差距分析与建议实施路线

`dsh-feishu` 已按下面的路线**实施完成**（见 `lib/index.js`、`lib/startup.js`、`lib/utils.js`）：

**P0（必修，否则跑不通）**
1. ✅ **修复会话事件订阅**：`lib/index.js` 移除 `agent.session.on("event")`（Session 无此方法，会抛错），改为 runner `ctx.on("session/event", ...)` 按 `session.id` 路由到对应 chat（`bySession` 反向映射）。

**P1（可用性/安全）** —— ✅ 全部实现
2. **群 @ 提及门控 + 用户 allowlist**：`admit()` 解析 `message.mentions` + bot 身份（配置或 `/bot/v3/info` 自动探测），`groupPolicy`(open/allowlist/disabled)、`requireMention`、`allowedUsers`、`allowAllUsers`。
3. **markdown → post 富文本**：`looksLikeMarkdown` 选 `post`(md)，`send` 失败降级 `stripMarkdown` 纯文本；长回复分片。
4. **webhook 安全**：`verificationToken`（header.token）+ `encryptKey`（`x-lark-signature` 校验）+ `makeRateLimiter` 限流 + body 上限 + Content-Type 校验。
5. **消息去重**：`isDuplicate()` 按 message_id + TTL。

**P2（体验）** —— ✅ 全部实现
6. **审批/澄清卡片**：复用 DSH 的 `approval/request` waterfall（`holder.agent.ctx.on`）与 `userQuestions.registerProvider` 契约，渲染成飞书交互卡片，`card.action.trigger` 回调经 `handleCardAction` 路由回结果（`allowed-once`/`rejected`、选项答案）。
7. **会话持久化**：`state.chats[chat_id] = sessionId` 写入 state 文件；重启用 `agents.resume({ resumeSessionId })` 续聊。

**P3（扩展）** —— ✅ 主要实现
8. bot 自消息过滤（`sender_type === "app"`，`allowBots` none/mentions/all）；处理中 reaction（`im.reaction.*`，可关）；突发文本批处理（debounce 合并）。

> 说明：媒体文件真实收发（下载/上传图片、文件）在 SDK 方法无法在本机验证的情况下仅做了**入站文本提示 + 占位**，未做完整文件管线；`post`(md) 与 `im.reaction.*` 的精确 SDK 签名需在装有 `@larksuiteoapi/node-sdk` 的真实环境冒烟验证（见 README「已知边界」）。

> **实现建议（已落地）**：hermes 的能力面很全但绑定 Python/自研框架，**不要照搬代码**；只需对照其能力矩阵，把每个能力映射到 DSH 的原始 API。DSH 侧真正的增值点是"审批/澄清"卡片——已通过 `approval/request` waterfall + `userQuestions.registerProvider` 两个官方契约实现。

---

## 5. 关键参考文件

**DSH（本机源码）**
- 表面范式：`@deepseek-ai/dsh-headless/lib/index.js`、`cordis.patch.yml`
- Agent API：`@deepseek-ai/dsh-agent/lib/index.js`、`lib/types/runtime-types.d.ts`
- Session 事件流：`@deepseek-ai/dsh-session/lib/index.js`（`Session` 类、`append` 发布 `session/event`）
- 订阅范式：`@deepseek-ai/dsh-session-title/lib/index.js`、`dsh-session-projection/lib/index.js`

**hermes（已摘录到 `_hermes_research/`）**
- 平台插件接入总览：`gateway__platforms__ADDING_A_PLATFORM.md`
- 飞书使用文档（权限/事件/能力矩阵/环境变量）：`website__docs__user-guide__messaging__feishu.md`
- 飞书适配器源码：`plugins__platforms__feishu__adapter.py`（约 5900 行，含双通道/富文本/卡片/媒体/限流）
- 飞书插件声明：`plugins__platforms__feishu__plugin.yaml`

**本仓库**
- `dsh-feishu/`：DSH 飞书表面插件（已按 P0–P3 路线实施完成，见 README）
- `T2_FeishuBot/`：早期独立 Python 飞书 webhook bot（可参考其 lark 调用与 config，但不走 DSH）

---

## 6. 项目结构 / 工作原理 / 关键设计点 / 测试

> 以下内容原在 README，因属开发者/贡献者视角，移入本文档。

### 6.1 目录结构

```
dsh-feishu/
├── package.json          # 声明 dsh.bundle.patch 指向 cordis.patch.yml；test 脚本
├── cordis.patch.yml      # 补丁层：插入 feishu-startup + feishu-runner
├── lib/
│   ├── index.js          # 主插件：飞书服务 + Agent 驱动 + 门控 + 审批卡片 + 会话持久化
│   ├── startup.js        # 解析命令行/配置，提供 feishuStartup 服务
│   ├── utils.js          # 纯工具函数（markdown/签名/限流/分片），可单测
│   └── types/            # 类型声明
├── test/                 # 单元测试（node 直接跑，无需安装依赖）
└── docs/feishu-channel-research.md   # 本文档
```

### 6.2 工作原理

- **表面机制**：仿照 `dsh-headless` / `dsh-web-app`，`cordis.patch.yml` 直接叠在 `dsh-base` 上。
- **Agent 驱动**：`ctx.agents.create()` 建 Agent（或 `agents.resume()` 恢复持久化会话），`agent.followup(createUserMessage(...))` 投递消息。
- **回复流回**：在 runner 的 `ctx` 上订阅 `session/event`（DSH 的会话事件流，按 `session.id` 路由到对应 chat），监听 `assistant/message` 调飞书 API 发回。
- **会话映射**：`Map<chat_id, ChatAgent>`，每个飞书会话一个独立 DSH 会话，`chat_id → sessionId` 持久化到 state 文件。

### 6.3 关键设计点

| 关注点 | 处理方式 |
|---|---|
| 会话映射 | 每个 `chat_id` 一个独立 DSH 会话（`Map` 缓存），多用户/多群互不干扰 |
| 持久化续聊 | 首次建会话后写 `state.chats[chat_id] = sessionId`；重启用 `ctx.agents.resume({ resumeSessionId })` 恢复 |
| 回复流回 | runner `ctx.on("session/event", ...)` 按 `session.id` 路由，长回复分片发送 |
| 审批/提问 | 复用 DSH 的 `approval/request` waterfall 与 `userQuestions.registerProvider` 契约，渲染成飞书卡片 |
| 退出 | 长驻服务不调 `appExit`（那是 headless 一次性用的）；处理 SIGINT/SIGTERM 优雅关闭 |

### 6.4 测试

纯工具函数（markdown 检测/清理、签名、限流、分片）在 `lib/utils.js`，用 `node test/utils.test.js` 跑（零依赖）：

```sh
pnpm test
```
