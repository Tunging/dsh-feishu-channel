# dsh-feishu 优化计划

> 本文档是 dsh-feishu 飞书频道插件的**当前状态 + 待办优化清单**，供后续对话直接读取继续开发。
> 仓库：`C:\Users\admin\Documents\_workspace\dsh-feishu`（git，远程 `https://github.com/Tunging/dsh-feishu-channel.git`，分支 `master`）

---

## 1. 项目现状

### 位置与运行
- 插件目录：`C:\Users\admin\Documents\_workspace\dsh-feishu`
- 已安装到 dsh 的 feishu profile 和 web profile（junction 指向此目录）
- 运行飞书 bot：
  ```powershell
  dsh --profile feishu --mode longconn --bots-file C:\Users\admin\bots.json --workspaces-file C:\Users\admin\workspaces.json
  ```
- 本地配置页：`http://127.0.0.1:8081`（`--config-port` 改端口）
- 测试：`cd C:\Users\admin\Documents\_workspace\dsh-feishu && pnpm test`
- 语法校验：`node --check lib/index.js`（等）

### 关键文件
- `lib/index.js` — 主插件（飞书服务、Agent 驱动、门控、审批卡片、命令、配置页、bot 切换）
- `lib/startup.js` — CLI 解析（`--app-id`/`--mode`/`--bots-file`/`--workspaces-file`/`--config-port` 等）
- `lib/onboard.js` — 扫码建应用流程（`setup` 命令 + 配置页扫码）
- `lib/autostart.js` — 挂载时 spawn 飞书 bot 子进程（web profile 用）
- `lib/utils.js` — 纯工具函数（markdown/签名/限流/分片）
- `lib/types/*.d.ts` — 类型声明
- `test/` — 单元测试（utils + onboard）

### 架构要点（后续开发需遵守）
- 表面 bundle：`cordis.patch.yml` 叠在 `dsh-base` 上，仿 `dsh-headless`
- Agent 驱动：`ctx.agents.create()` / `agents.resume({resumeSessionId})`，`agent.followup(createUserMessage(...))`
- 回复流回：runner `ctx.on("session/event", ...)` 按 `session.id` 路由（**不要用 `agent.session.on`，Session 无此方法**）
- 模型选择：`agentDefaultModel.currentSelection()` + `installModelSelection`（setup 里**不要返回**其返回值，用显式块）
- 审批：`approval/request` waterfall（`holder.agent.ctx.on`）；提问：`userQuestions.registerProvider({ask})`
- 长连接：`new lark.WSClient({...}).start({ eventDispatcher: { invoke: (mergedData) => handleIncoming(mergedData) } })`（mergedData 就是完整事件）
- reaction：`client.im.messageReaction.create/delete`（不是 `im.reaction`）
- schemastery：对象字段默认可选，用 `.required()` 标记必填，**没有 `.optional()`**

---

## 2. 已完成的功能

- 基础事件订阅修复（`session/event`）
- 群 @ 提及门控 + 用户 allowlist + groupPolicy
- markdown → post 富文本（失败降级纯文本）
- webhook 安全（verification token / encrypt key 签名 / 限流 / body 上限）
- 消息去重（message_id + TTL）
- 审批/澄清卡片（`approval/request` + `userQuestions`）
- 会话持久化（chat_id → sessionId，`agents.resume` 续聊）
- bot 自消息过滤、处理中 reaction、突发文本批处理
- 命令：`/workspace` `/bot` `/help` `/status` `/debug` `/reset`、@占位符剥离、未知命令提示
- 扫码接入（`dsh --profile feishu setup`）
- 本地配置页（扫码添加 + 手动填写，编辑 bots/workspaces）
- autostart 自动启动（web profile 挂载时 spawn 飞书 bot）
- git 管理 + 推送到 GitHub

---

## 3. 待办优化清单（按优先级）

### 第一批：安全规则（推荐先做）
- [x] **管理员 + 按群细粒度权限**：设管理员 open_id；每个群可配 open/allowlist/blacklist/admin_only/disabled（参考 hermes `group_rules`）
- [x] **工具白名单**：限制 Agent 能用哪些工具（按会话/群配置）
- [x] **危险命令二次确认**：`rm`、`git push`、`git reset --hard` 等必须卡片确认
- [x] **敏感信息脱敏**：日志隐藏 app_secret、open_id

### 第二批：媒体增强
- [x] **图片/文件收发完整管线**：入站下载（`im.messageResource.get`）、出站上传（`im.image.create`/`im.file.create`），当前只做了入站文本提示

### 第三批：会话/记忆
- [x] `/export` 导出对话为 markdown 发回飞书
- [x] 空闲会话清理（释放内存）
- [x] 启动注入项目背景（system prompt 定制）

### 第四批：命令扩展
- [ ] `/model` 卡片切换模型
- [ ] `/stop` 中断当前生成

### 第五批：健壮性
- [ ] 单次回复超时、回复长度上限
- [ ] 错误推送到飞书（不只写日志）
- [ ] 审计日志（谁在何时用了什么命令）

### 第六批：多 Agent / 通知
- [ ] 按命令路由到不同 Agent（`/code` 走代码 Agent）
- [ ] 定时提醒/任务推送到飞书（复用 `dsh-schedule`）
- [ ] 事件订阅（文档评论、会议邀请）

---

## 4. 已知边界 / 待验证

- `@larksuiteoapi/node-sdk` 的 `im.message.create` / `im.messageReaction.*` / `wsClient` 精确签名需在真实环境冒烟验证
- 飞书 `post`(md) 对部分 markdown 构造可能拒绝（已降级纯文本）
- bot 身份（open_id）默认 `/bot/v3/info` 自动探测（异步、尽力而为），可用 `--bot-open-id`/`--bot-name` 指定
- 凭据文件（`bots.json`/`workspaces.json`/`feishu-credentials.json`）是明文，已 gitignore，但需注意别外传

---

## 5. 下一步建议

从**第一批安全规则**开始（管理员/按群权限 + 工具白名单 + 危险命令确认 + 脱敏）。实现时：
1. 先读 `lib/index.js` 现有门控（`admit`/`allowlistAllows`）和命令（`handleCommand`）结构
2. 新增配置项（管理员、群规则、工具白名单）到 `Config` schema + `startup.js`
3. 危险命令确认复用现有 `approval/request` 卡片机制
4. 改完跑 `pnpm test` + `node --check`，再 `git add -A && git commit && git push`
