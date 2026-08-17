# 飞书内工作区管理（增删改查）设计

> 日期：2026-08-17
> 状态：已确认，待实现
> 关联：`lib/index.js`、`lib/startup.js`、`lib/types/*.d.ts`、`test/`

## 背景

`dsh-feishu` 已实现 `/workspace` 切换功能（弹卡片点按钮切换工作区），但工作区清单只能通过本地配置页（`http://127.0.0.1:8081`）或启动参数 `--workspaces-file` 提供的 JSON 文件来维护。本设计在飞书内直接支持工作区的**增删改查**，无需离开飞书。

## 需求

- 在飞书里直接**新增 / 删除 / 修改 / 查看**工作区。
- 权限可配置：`--workspace-manage <admin|all>`，默认 `admin`。
- 输入方式：飞书**输入卡片**（填名字 + 路径）。
- 校验：**名字去重** + **路径存在性**。
- 边界：删除 → 正在使用该工作区的会话回退到默认工作区；改名/改路径 → 下次切换/重建时用新值。

## 方案

采用**方案 C（混合入口）**：`/workspace` 切换卡片底部加"⚙️ 管理"按钮，点它打开管理卡片（增删改）。

## 设计

### 1. 配置与权限

- 新增配置字段 `workspaceManage`：`z.enum(["admin", "all"]).default("admin")`（`lib/index.js` 的 schema）。
- 新增 CLI 参数 `--workspace-manage <admin|all>`（`lib/startup.js`）。
- 新增权限判断函数 `canManageWorkspaces(openId)`：
  - `workspaceManage === "all"` → 直接放行；
  - 否则 → 复用现有 `isAdmin(openId)`（`--admins` 白名单）。
- 从卡片事件取操作者身份：`event.operator.operator_id.open_id`（飞书 `card.action.trigger` 事件结构）。

### 2. 卡片交互流程

- **`/workspace` 切换卡片**：保留现有工作区按钮，底部加"⚙️ 管理"按钮（`value.k = "fs_ws_manage"`）。
- **管理卡片**（点"管理"后弹出）：列出每个工作区，各带"✏️ 编辑"和"🗑 删除"按钮，底部加"➕ 新增"按钮。
- **新增/编辑输入卡片**：两个输入框（名字、路径）+ "保存"/"取消"按钮；编辑时预填当前值。
- **删除确认卡片**：点"删除"后先弹"确认删除 X？"（确认/取消），防止误删。
- 所有管理操作（新增/编辑/删除）先过 `canManageWorkspaces` 权限检查，无权限则提示。

### 3. 校验与持久化

- **保存时校验**：名字非空、路径非空、名字去重（编辑时排除自身）、路径存在（`fs.existsSync`）。
- **校验失败**：发回错误卡片/文本，说明原因。
- **校验通过**：更新 `config.workspaces`，调用现有 `saveWorkspacesFile()` 写回 JSON 文件（重启后仍生效）。

### 4. 边界情况

- **删除**：遍历 `state.workspaces`，把路径匹配被删工作区的会话记录清掉 → 这些会话回退到默认工作区（`--workspace` 根目录）。
- **改名/改路径**：正在用它的会话保留旧快照，下次切换/重建时用新值。

### 5. 测试

- 把**校验逻辑**（名字去重、路径存在性）抽成纯函数，加单元测试（`test/` 下，沿用现有测试风格）。
- 卡片渲染和飞书交互无法单测，重点测校验 + 状态变更逻辑。

## 涉及文件

- `lib/index.js`：schema、权限函数、卡片渲染、`handleCardAction` 路由、校验与持久化。
- `lib/startup.js`：新增 `--workspace-manage` 参数。
- `lib/types/index.d.ts`、`lib/types/startup.d.ts`：类型声明。
- `test/`：校验逻辑单元测试。
- `README.md`：文档更新。
