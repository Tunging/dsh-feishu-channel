# README.zh.md 高优先级补充草稿

> 这是给 `deepseek-ai/deepseek-harness` 的 `README.zh.md` 提 PR 用的**草稿**，只覆盖高优先级四项。
> 插入位置建议：放在「## 开发者预览」之后、「## 运行」之前。
> ⚠️ 标注「需核实」的地方请对照官方文档/源码确认后再提交。

---

## 功能特性

- **一切皆插件**：基于 [Cordis](https://github.com/cordiverse/cordis) 的插件化架构，核心能力（Agent、工具、存储、通道、UI）都以插件组合，可自由裁剪与扩展。
- **Agent 驱动**：通过 `ctx.agents` 创建 / 恢复 Agent，支持会话持久化、续聊、多 Agent 路由。
- **工具系统**：内置 bash / pwsh、文件读写、搜索、Web、子 Agent、工作流等工具，支持工具白名单、审批、危险命令确认。
- **Web UI**：`dsh web` 启动浏览器界面（默认 `http://127.0.0.1:3080`），可视化对话、Agent、工具与设置。
- **Headless**：`dsh --profile headless "任务"` 一次性跑完任务并打印结果，适合脚本 / CI。
- **多通道**：可接入飞书 / Lark 等 IM 通道，在聊天里直接驱动 Agent。
- **会话持久化**：会话事件日志持久化，重启后可恢复。
- **模型可配置**：通过 `agentDefaultModel` 配置默认模型，支持多 provider。

> 需核实：工具清单、多通道、模型配置的具体表述以官方文档为准。

---

## 快速开始

### 系统要求

- Node.js 18+（建议 20+）— *需核实具体版本要求*
- 支持 Windows / macOS / Linux

### 安装并启动 Web UI

```sh
npx @deepseek-ai/dsh web
```

首次启动会自动初始化 `web` profile，浏览器打开 `http://127.0.0.1:3080`。

### 配置模型

在 Web UI 的「设置」里配置模型 provider 与 API key（如 DeepSeek、OpenAI 等），或通过环境变量 / 配置文件指定。— *需核实具体配置入口*

### 运行一次性任务（headless）

```sh
npx @deepseek-ai/dsh --profile headless "运行测试"
```

---

## CLI 命令

| 命令 | 说明 |
|---|---|
| `dsh web` | 启动 Web UI（`--profile web` 的别名） |
| `dsh --profile <name>` | 启动指定 profile |
| `dsh --profile headless "任务"` | 跑一次性任务并打印结果 |
| `dsh plugin --profile <name> <pnpm 参数>` | 管理 profile 的插件（转发给 pnpm） |
| `dsh --dump-default-config` / `--dump-config` | 查看组合后的配置树（不启动） |
| `dsh --help` | 查看启动器帮助 |

> 启动器只解析自己的 flag，其余参数交给 profile 里的应用插件解析。例如 `dsh --profile web --port 8080` 的 `--port` 属于 web 应用。

---

## 插件开发

dsh 的一切都是插件。一个插件就是一个 Cordis 插件，通过 `cordis.patch.yml` 叠加到 profile 上。

### 最小插件

```js
// my-plugin.js
export const name = "my-plugin";
export function apply(ctx) {
  ctx.on("ready", () => console.log("hello from my-plugin"));
}
```

### 打包成 bundle

在 `package.json` 里声明：

```json
{
  "name": "@you/my-plugin",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

### 安装到 profile

```sh
dsh plugin --profile web add @you/my-plugin
dsh plugin --profile web install
```

详细开发指南见 [docs/development.md](docs/development.md) 与 [docs/architecture.md](docs/architecture.md)。为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题便于被发现。
