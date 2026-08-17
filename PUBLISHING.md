# 发布指南（PUBLISHING）

本插件 `@tunging/dsh-feishu` 的发布与安装流程。dsh 的正式安装是按**包名从 npm registry** 解析的（`dsh plugin install`），所以要让别人能一键安装，必须发布到 npm。

---

## 0. 前置条件

- 一个 **npm 账号**，且 scope 为 `tunging`（若不是，先把 `package.json` 和 `cordis.patch.yml` 里的 `@tunging` 改成你的真实 scope）。
- 本机已登录 npm（`npm whoami` 能返回用户名）。
- 已推送代码到 GitHub（`git push origin master`）。

---

## 1. 首次发布

```powershell
cd C:\Users\admin\Documents\_workspace\dsh-feishu

# 1) 登录 npm（首次）
npm login

# 2) 检查发布包内容（确认 files 字段已包含 lib/*.js、cordis.patch.yml、lib/types/*.d.ts）
npm pack --dry-run

# 3) 发布（scoped 包默认私有，需 --access public）
npm publish --access public
```

发布成功后验证：

```powershell
npm view @tunging/dsh-feishu
```

能看到版本信息即成功。

---

## 2. 发布新版本

改完代码、跑过测试后：

```powershell
# 1) 提交代码
git add -A
git commit -m "feat: 说明改动"
git push origin master

# 2) 升版本号（patch / minor / major 按改动幅度选）
npm version patch   # 0.1.0 -> 0.1.1
# 或 npm version minor  # 0.1.0 -> 0.2.0
# 或 npm version major  # 0.1.0 -> 1.0.0

# 3) 发布
npm publish --access public
```

> `npm version` 会自动改 `package.json` 的 version 并打一个 git tag。记得把 tag 也推上去：`git push origin master --tags`。

---

## 3. 在 dsh profile 里安装

```powershell
# 把 bundle 加进 profile 并安装依赖
dsh plugin --profile feishu add @tunging/dsh-feishu
dsh plugin --profile feishu install

# 运行
dsh --profile feishu --mode longconn --bots-file C:\Users\admin\bots.json --workspaces-file C:\Users\admin\workspaces.json
```

---

## 4. 提高可发现性

### GitHub Topics
在仓库页右上角 **About → ⚙️ → Topics** 添加：
`dsh`、`deepseek-harness`、`feishu`、`lark`、`bot`、`cordis`、`channel`

### README
`README.md` 已包含功能清单、命令、配置项、安装/发布步骤，保持更新即可。

---

## 5. 常见问题

### `npm publish` 报 `ENEEDAUTH` / `need auth`
未登录。先 `npm login`。

### `npm publish` 报 scope 不存在 / 无权
你的 npm 账号 scope 不是 `tunging`。把 `package.json` 和 `cordis.patch.yml` 里的 `@tunging` 改成你真实拥有的 scope，再发布。

### `git push` 报 `SEC_E_NO_CREDENTIALS`
Git Credential Manager 在非交互环境取不到凭据。在**终端**里手动执行 `git push origin master`（会弹 GCM 登录窗口），或配置 PAT。

### 发布后 `dsh plugin install` 拉不到
确认 `npm view @tunging/dsh-feishu` 能查到，且 profile 的 `dsh.profile.bundles` 里写的是 `@tunging/dsh-feishu`（不是 `@you/...`）。

---

## 6. 不想发布到 npm？

可继续用**本地 junction** 方式安装（开发/自用），无需发布。见 `README.md` 的「方式二：本地开发安装」。
