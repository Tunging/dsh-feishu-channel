# dsh-feishu — 通过飞书机器人接入 DeepSeek Harness

一个 DSH **表面（surface）bundle**：在 `dsh-base` 之上叠加一层，让飞书机器人驱动 DSH 的 Agent。
每个飞书会话（chat_id）对应一个独立的 DSH 会话，用户消息经 `agent.followup` 投递，assistant 回复经 DSH 的 `session/event` 事件流回飞书。

## 快速开始

```powershell
# 1) 扫码创建飞书机器人应用（自动保存凭据，无需开发者后台）
dsh --profile feishu setup

# 2) 启动 bot（长连接，无需公网回调地址）
dsh --profile feishu --mode longconn

# 3) 在飞书里 @ 机器人，开始对话
```

> 已有 app_id / app_secret 时，直接：
> `dsh --profile feishu --app-id cli_xxx --app-secret yyy --mode longconn`
>
> 完整安装、飞书开放平台配置、CLI 选项见下文「安装与运行」。

> 开发者 / 贡献者：项目结构、工作原理、关键设计点、测试见 [docs/feishu-channel-research.md](docs/feishu-channel-research.md)。

## 功能清单

| 能力 | 说明 |
|---|---|
| 双通道 | `webhook`（事件订阅）或 `longconn`（WebSocket 长连接，无需公网） |
| 群门控 | 群内需 @ 机器人才响应；`--group-policy`（open/allowlist/disabled）+ `--require-mention` |
| 用户鉴权 | `--allowed-users`（open_id 白名单）+ `--allow-all-users`（dev） |
| 富文本 | markdown 自动转飞书 `post`(md)，失败降级纯文本；长回复分片 |
| Webhook 安全 | `--verification-token` + `--encrypt-key` 签名校验 + 限流 + body 上限 |
| 去重 | 按 message_id + TTL 去重，防 webhook 重投 |
| 审批卡片 | 危险命令审批渲染成飞书交互卡片（批准一次/拒绝） |
| 提问卡片 | `ask_user_question` 工具渲染成选项卡片 |
| 会话持久化 | 重启后按 `chat_id` 恢复历史会话（`agents.resume`） |
| 突发批处理 | 文本 debounce 合并，避免刷屏打爆 Agent |
| 管理员/按群权限 | `--admins` + `--group-rules`（open/allowlist/blacklist/admin_only/disabled） |
| 工具白名单 | `--allowed-tools` 限制 Agent 可用工具 |
| 危险命令二次确认 | `--dangerous-commands` 命中规则时弹卡片确认（复用审批卡片） |
| 日志脱敏 | 隐藏 app_secret / open_id / chat_id |
| 媒体收发 | 入站下载（`im.messageResource.get`）、出站上传（`im.image.create`/`im.file.create`） |
| 多 Agent | `/code` 路由到独立代码 Agent（`--code-agent-model`/`--code-agent-context`） |
| 定时提醒 | `/remind` 定时推送到飞书 |
| 健壮性 | 回复超时、回复长度上限、错误推送飞书、审计日志、空闲会话清理 |
| 事件订阅 | `--subscribe-events` 处理文档评论、会议邀请等事件 |
| 其他 | bot 自消息过滤、处理中 reaction（可关）、`--domain` feishu/lark |

## 安装与运行

> **Windows 说明**：以下命令在 **PowerShell** 里执行（`dsh` 在 Windows 上是 `dsh.ps1`）。PowerShell 5.1 不支持 `&&`，所以每条命令单独一行。终端二维码建议用 **Windows Terminal**（经典 cmd 可能显示乱码）；不显示二维码也没关系，直接打开打印的链接即可。

### 0. 扫码接入（推荐，无需开发者后台）

装好依赖后，一条命令即可用飞书 App 扫码创建机器人应用并自动保存凭据：

```powershell
cd dsh-feishu
pnpm install
dsh --profile feishu setup
```

`setup` 会打印一个链接（加 `--qr` 可显示 ASCII 二维码，需先 `pnpm add qrcode`）。用**飞书 App** 扫码或打开该链接，确认授权后，应用会自动创建并把 `app_id` / `app_secret` 保存到 `%USERPROFILE%\.dsh\feishu-credentials.json`（即 `C:\Users\<你>\.dsh\feishu-credentials.json`）。之后直接运行即可，无需再传凭据：

```powershell
dsh --profile feishu --mode longconn
```

> 说明：`setup` 走的是飞书官方「扫码建应用」device-code 流程（`accounts.feishu.cn/oauth/v1/app/registration`），与 hermes-agent 的 `hermes gateway setup` 同源。若你的飞书环境不支持该流程，仍可手动在 [open.feishu.cn](https://open.feishu.cn) 建应用后传 `--app-id`/`--app-secret`。

### 1. 创建 profile

```powershell
# 在 dsh-feishu 目录安装依赖
cd dsh-feishu
pnpm install
pnpm test                 # 跑单元测试

# 创建 feishu profile
dsh plugin --profile feishu add @tunging/dsh-feishu
```

profile 目录 `$DSH_HOME/profiles/feishu/` 的 `package.json` 里 `dsh.profile.bundles` 应包含：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@tunging/dsh-feishu"]
    }
  }
}
```

审批卡片需要 DSH 的 `@deepseek-ai/dsh-user-approval`（base 已含）；提问卡片需要 `@deepseek-ai/dsh-user-questions` + `@deepseek-ai/dsh-tool-ask-user`，两者都是可选的（未启用时自动降级）。

### 2. 飞书开放平台配置

- 创建企业自建应用，拿到 **App ID** 和 **App Secret**，开启「机器人」能力。
- **事件订阅**：订阅 `im.message.receive_v1`；审批卡片还需订阅 `card.action.trigger` 并开启「交互卡片」能力。
- `webhook` 模式：配置事件回调地址为 `http://<公网地址>:<port><path>`；`longconn` 模式无需回调地址。

### 3. 运行

```powershell
# 事件订阅模式（需公网回调地址，或内网穿透）—— 一行写完，PowerShell 用反引号 ` 续行
dsh --profile feishu --app-id cli_xxx --app-secret yyy --mode webhook --port 8080 --allowed-users ou_xxx,ou_yyy --verification-token t --encrypt-key k

# 长连接模式（无需公网）
dsh --profile feishu --app-id cli_xxx --app-secret yyy --mode longconn
```

完整 CLI 选项见 `dsh --profile feishu --help`。

## 工作区切换（免输入）

给 bot 配一份工作区清单，然后在飞书里发 `/workspace`，bot 会弹出一张**可点击的卡片**，点按钮就切换——不用手动敲路径。

**准备工作区清单**：建一个 JSON 文件，如 `C:\Users\admin\workspaces.json`：

```json
[
  { "name": "T2 客户端", "path": "C:\\Users\\admin\\Documents\\_workspace\\t2\\Client_T2" },
  { "name": "T2 战斗服务", "path": "C:\\Users\\admin\\Documents\\_workspace\\t2\\BattleProject" }
]
```

**启动时指定**：

```powershell
dsh --profile feishu --mode longconn --workspaces-file C:\Users\admin\workspaces.json
```

**在飞书里用**：
1. 给机器人发 `/workspace`。
2. 机器人回一张卡片，列出所有工作区按钮。
3. 点某个按钮 → 该会话的工作区切换过去（Agent 的 `cwd` 跟着变，并记住；重启后仍生效）。

> 切换工作区时，当前会话会**重建 Agent**（历史对话上下文清空，属于正常行为）。未配置清单时发 `/workspace` 会提示先配 `--workspaces-file`。

## 命令

在飞书里给机器人发 `/` 开头的命令（本地处理，不发给 Agent）：

| 命令 | 作用 |
|---|---|
| `/workspace` | 弹出工作区选择卡片（免输入切换） |
| `/bot` | 弹出机器人选择卡片（免输入切换，会重连） |
| `/model` | 弹出模型选择卡片（切换模型） |
| `/stop` | 中断当前生成 |
| `/code <任务>` | 交给代码 Agent 处理 |
| `/remind <时长> <内容>` | 定时提醒，如 `/remind 10m 喝水` |
| `/status` | 查看当前工作区 / 模型 / 会话 |
| `/debug` | 诊断信息：模式、app_id、domain、会话数、群策略等 |
| `/reset` | 重置当前会话（清空上下文，重新开始） |
| `/export` | 导出当前对话为 markdown 文件发回飞书 |
| `/restart` | 重启飞书频道（插件内置，无需外部脚本） |
| `/autostart on\|off` | 开启/关闭开机自启（插件内置，Windows） |
| `/help` | 列出可用命令 |

未知的 `/` 命令会收到提示。群消息里的 `@_user_1` 等 @ 占位符会在喂给 Agent 前自动剥离。

> 重启与开机自启都由插件内置管理，不依赖任何本地脚本。`/autostart on` 会在 Windows 启动文件夹写入一个自启入口，`/autostart off` 移除它。

## 切换机器人（免输入）

配一份机器人清单，发 `/bot` 弹卡片点按钮切换（会重连到新机器人）。

**准备清单**（JSON，如 `C:\Users\admin\bots.json`）：

```json
[
  { "name": "开发机器人", "appId": "cli_xxx", "appSecret": "secret1", "domain": "feishu" },
  { "name": "生产机器人", "appId": "cli_yyy", "appSecret": "secret2", "domain": "feishu" }
]
```

**启动时指定**：

```powershell
dsh --profile feishu --mode longconn --bots-file C:\Users\admin\bots.json
```

**在飞书里**：发 `/bot` → 点按钮 → 切换到对应机器人（重连，@提及门控的 bot 身份也会重新探测）。

> 切换机器人会断开并重连长连接；新机器人同样需在开发者后台配好长连接事件订阅并发布。

## 本地配置页

bot 启动时会起一个本地网页（默认 `http://127.0.0.1:8081`），可视化编辑**机器人列表**和**工作区列表**，改完点「保存」写回 `bots.json` / `workspaces.json`。

```powershell
dsh --profile feishu --mode longconn --bots-file C:\Users\admin\bots.json --workspaces-file C:\Users\admin\workspaces.json
```

浏览器打开 `http://127.0.0.1:8081` 即可。端口用 `--config-port <port>` 改。

**添加机器人有两种方式**：
- **📷 扫码添加**：点「扫码添加」，页面显示二维码，用飞书 App 扫码/打开链接授权，自动创建应用并加入列表（无需开发者后台）。
- **+ 手动填写**：直接填 name / App ID / App Secret / domain。

> 配置页只监听 `127.0.0.1`（本机），不对外网开放。保存后需重启 bot 生效；机器人切换也可在飞书里发 `/bot`。

## 发布到 npm

dsh 的正式安装是按**包名从 npm registry** 解析的（`dsh plugin --profile <name> install`），光放 GitHub 不够。完整发布流程（首次发布、版本升级、常见问题）见 **[PUBLISHING.md](PUBLISHING.md)**。

> 不想发布到 npm 时，可继续用本地 junction 方式安装（开发/自用）。

## 社区与支持

- 本插件依赖的 dsh 处于**开发者预览**阶段，未来可能有破坏性变更，请关注 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的更新。
- 反馈 / bug 报告可到 [deepseek-harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)。
- 本仓库已按官方建议使用 `dsh-plugin` 话题，便于被 dsh 生态发现。

## 已知边界（需真实飞书/运行环境验证）

- 使用了 `@larksuiteoapi/node-sdk` 的 `im.message.create` / `im.messageReaction.*` / `wsClient`，这些方法的精确签名需在装有该 SDK 的环境里冒烟验证。
- 飞书 `post`(md) 对部分 markdown 构造可能拒绝，代码已降级纯文本，但具体行为以线上为准。
- bot 身份（open_id）默认通过 `/bot/v3/info` 自动探测（异步、尽力而为），也可用 `--bot-open-id`/`--bot-name` 显式指定。
- 媒体管线（`im.messageResource.get` / `im.image.create` / `im.file.create`）、`/model` 切换、`/code` 代码 Agent、`/remind`、事件订阅均需在真实环境冒烟验证。
- 事件订阅（文档评论、会议邀请）需在飞书开放平台为应用配置对应事件订阅后才会收到事件。
