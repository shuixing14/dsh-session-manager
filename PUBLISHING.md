# 部署与发布指南

本页说明两件事：

1. **部署** —— 把插件装进你自己的 DeepSeek Harness（四种方式 + 校验 / 启用 / 卸载）。
2. **发布** —— 把插件发布到 **DSH 插件库（plugin market index）** 与 npm / GitHub Release。

> 插件库索引：[`docs/plugin-index.json`](docs/plugin-index.json)（GitHub Pages 托管，格式 `format: 1`）。
> 在线地址：<https://shuixing14.github.io/dsh-session-manager/plugin-index.json>

---

## 一、部署到自己的 DSH

### 方式 ①：DSH 插件管理器（bundle，推荐）

在 Harness 会话里让 Agent 执行：

```
plugin_manager install_bundle  target: /path/to/dsh-session-manager
```

装完对整个 profile 生效，**刷新一次页面**即可。

### 方式 ②：Release tarball

```bash
# 从 Releases 下载 dsh-session-manager-<version>.tgz 后
dsh plugin --profile desktop add ./dsh-session-manager-0.2.0.tgz
```

### 方式 ③：本地开发（link）

```bash
dsh plugin --profile desktop add link:/path/to/dsh-session-manager
```

### 方式 ④：手工挂载

1. 在 profile 的 `package.json` 依赖里加入本包（`link:` 或版本号）；
2. 在 profile 的 `cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: dsh-session-manager
      name: dsh-session-manager
```

### 校验 / 启用 / 卸载

```bash
# 探活（端口以运行时为准，见 Host 启动日志或窗口地址）
curl http://127.0.0.1:<port>/dsh-session-manager/status

# 启用 / 停用
plugin_manager set_bundle  target: dsh-session-manager  enabled: true
plugin_manager set_bundle  target: dsh-session-manager  enabled: false

# 卸载
dsh plugin --profile desktop remove dsh-session-manager
```

> 排错：`404` 表示插件行没有加载（重启 Harness 后再刷新页面）；
> `403 请求被拒绝（非本机同源）` 表示请求没有带宿主 cookie / 页面口令。

---

## 二、发布到 DSH 插件库（market index）

DSH 的「插件市场 / Discover」读取一个 **JSON 索引**（`format: 1`）。索引由你自己托管，
用户把索引 URL 加进 DSH 即可浏览与安装。

### 索引结构（本仓库的 `docs/plugin-index.json`）

```jsonc
{
  "format": 1,
  "title": { "en": "DeepSeek Harness plugins", "zh": "DeepSeek Harness 插件库" },
  "description": { "en": "...", "zh": "..." },
  "metadata": {
    "categories": { "session": { "title": { "en": "Sessions", "zh": "会话" } } },
    "labels":     { "session-tools": { "title": { "en": "Session tools", "zh": "会话管理" } } }
  },
  "plugins": [
    {
      "name": "dsh-session-manager",              // 必须与 package.json 的 name 一致
      "title": { "en": "...", "zh": "..." },
      "description": { "en": "...", "zh": "..." },
      "icon": "icon.png",                          // 相对索引地址，或 https 绝对地址 / base64 data URL
      "author": "dsh-session-manager contributors",
      "homepage": "https://shuixing14.github.io/dsh-session-manager/",
      "repository": { "url": "https://github.com/shuixing14/dsh-session-manager" },
      "metadata": {
        "category": "session",
        "keywords": ["session", "delete", "backup"],
        "labels": ["session-tools"]
      },
      "versions": [
        {
          "version": "0.2.0",                      // 精确 SemVer
          "publishTimestamp": 1794772800,          // Unix 秒
          "source": {                              // npm 或 git 二选一
            "type": "git",
            "url": "https://github.com/shuixing14/dsh-session-manager",
            "commit": "96c283998d7e5fb2dd3b387fb82e0037a42cce2e"
          },
          "engines": { "dsh": ">=0.2.0-rc.2" }     // 可选：DSH 版本范围
        }
      ]
    }
  ]
}
```

字段规则（由 DSH 的 `@deepseek-ai/dsh-plugin-market-index` 校验）：

| 字段 | 规则 |
| --- | --- |
| `format` | 必须是 `1` |
| `title` / `description` | 字符串或本地化对象，本地化对象**必须含 `en`** |
| `plugins[].name` | 合法 npm 包名，且不能重复 |
| `versions` | 非空数组；`version` 为精确 SemVer；同一插件版本不可重复 |
| `versions[].publishTimestamp` | Unix 秒（整数，`[0, 10^11)`） |
| `versions[].source` | `{ "type": "npm" }`（可带 `registry`）或 `{ "type": "git", "url": <https 仓库 URL>, "commit": <40 位小写 hex> }` |
| `icon` | 相对索引地址、https 绝对地址，或 ≤32 KiB 的 base64 data URL（SVG/PNG/JPEG/WebP） |
| `metadata.labels` / `category` | 必须引用 `metadata.labels` / `metadata.categories` 里**已声明**的 id |

> 安装目标由索引推导：npm 源 → `dsh-session-manager@0.2.0`；
> git 源 → `git+https://github.com/shuixing14/dsh-session-manager.git#<commit>`。

### 托管索引

任选其一（必须是可直接 GET 的 HTTPS URL）：

- **GitHub Pages**（本仓库采用）：`docs/plugin-index.json` → `https://<user>.github.io/<repo>/plugin-index.json`
- 任意静态托管 / 对象存储 / 自己的服务器。

本仓库已在 **Settings → Pages** 用 `main` 分支的 `/docs` 目录发布，站点首页即本插件介绍页。

### 让用户添加索引

1. DSH 设置 → 插件市场（Discover）→ 添加索引源，粘贴上面的 URL；或
2. 在 profile 的 patch 里给 `plugin-market` 行配置：

```yaml
- id: plugin-market
  config:
    indexes:
      - https://shuixing14.github.io/dsh-session-manager/plugin-index.json
```

之后在「Discover」页即可看到本插件并一键安装。

---

## 三、发布到 npm（可选）

索引也支持 npm 源。若发布到 npm：

```bash
npm login --registry https://registry.npmjs.org
npm publish --access public        # package.json 已含 publishConfig.access=public
```

然后把索引里的 `source` 改为：

```json
{ "type": "npm", "registry": "https://registry.npmjs.org" }
```

---

## 四、发版流程（每次发布）

```bash
# 1. 升版本 + 写 CHANGELOG
npm version patch --no-git-tag-version     # 或 minor / major
# 2. 跑全部离线测试
npm run check && npm test
# 3. 打包
npm pack                                  # → dsh-session-manager-<version>.tgz
# 4. 提交、打 tag、推送
git add -A && git commit -m "release: v<version>"
git tag -a v<version> -m "dsh-session-manager <version>"
git push origin main --tags
# 5. 创建 GitHub Release 并附上 tarball
gh release create v<version> dsh-session-manager-<version>.tgz \
  --title "v<version>" --notes-file RELEASE_NOTES.md
# 6. 更新插件库索引：新增一条 version（新 commit SHA、publishTimestamp）
```

> 索引里的 git 源必须指向**该版本代码的 commit**；发布后把 `versions[]` 追加新版本，
> 旧版本保留可回退。

---

## 五、当前索引状态

| 项 | 值 |
| --- | --- |
| 索引地址 | <https://shuixing14.github.io/dsh-session-manager/plugin-index.json> |
| 格式 | `format: 1` |
| 已收录 | `dsh-session-manager@0.2.0`（git 源，commit `96c2839…`） |
| 校验 | 已用 DSH 自带的 `parseMarketIndex` 校验通过（图标解析、安装目标推导均正常） |
