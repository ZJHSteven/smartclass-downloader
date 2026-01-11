# smartclass-downloader（Tampermonkey 用户脚本）

本仓库主要内容是一个 Tampermonkey 用户脚本：在智慧课堂播放页中批量生成 MP4 下载任务，并尽量走 API 直接拿到播放信息以提升速度。

## 目录结构（从可维护性角度理解项目）

- `smartclass-downloader.user.js`：主脚本（Tampermonkey 安装/运行的就是它）
- `CHANGELOG.md`：更新日志（给“使用者/未来自己”看的变更说明）

## 开发约定（便于长期维护）

### 1) 版本与日志同步

- 每次功能/修复发布时：
  - 同步更新 `smartclass-downloader.user.js` 头部的 `@version`
  - 同步更新 `CHANGELOG.md`，写清楚“改了什么、为什么改、影响范围”

### 2) `csrkToken` 获取策略（避免“验证不通过”）

站点接口 `/Video/GetVideoInfoDtoByID` 往往需要携带 `csrkToken`。

脚本的可靠策略是：

- **不去猜 token 在哪里**（URL / cookie / window 变量都可能拿不到）
- **直接从页面真实网络请求里捕获**（hook XHR/fetch，遇到该接口就提取 `csrkToken`）
- **抓到后缓存到 `localStorage`**（当前 key：`tm_csrkToken_v2`），后续 API 调用优先使用缓存

> 这样可以显著降低 `Success:false, Message:"验证不通过"` 这类错误概率。

### 3) UI 设计原则（解决“灰字看不清/太难看”）

脚本浮层 UI 的目标是：**清晰、对比度高、结构简单**。

- 样式集中在脚本里注入的 `#tm_panel` 相关 CSS（避免零散 inline style 难维护）
- 深色半透明背景 + 亮色文字：关键文字优先使用 `#ffffff`，避免“灰字+灰底”导致看不清；不滥用过低的 `opacity`
- 组件尽量“少而完整”，避免为了模块化把一行逻辑拆成多个函数（初学者更易读）
- 日志默认以“迷你列表”展示最近几条（置顶 + 固定高度），完整日志放在折叠面板里，避免遮挡主列表

### 4) 下载文件命名规则（v2，短文件名）

为了解决“文件名太长、不好扫一眼”的问题，脚本把 mp4 文件名统一简化成：

- 格式：`M.D-课程(可简写)-老师-开始小时-结束小时.mp4`
- 示例：`12.12-生理-王栋-8-9.mp4`

其中：

- 日期：只保留“月.日”，去掉年份（`2025-12-09` → `12.9`）
- 课程：优先查“课程简写表”，命中则替换，否则保留原名
  - 人体功能学 → 生理
  - 病原与免疫 → 病原
  - 马克思主义基本原理 → 马原
  - 医学基础II/Ⅱ → 生化
  - 医学术语学2/Ⅱ → 英语
- 老师：只保留老师名，不写教室/地点
- 时间：只保留“小时”，不写分钟（8:00-8:45 → 8-8；8:55-9:40 → 8-9）

### 5) Gopeed 外部下载器（新下载链路）

脚本已改为 **通过 Gopeed HTTP API 提交下载任务**，不再使用 `GM_download` 或浏览器下载器。

- **默认地址**：`http://127.0.0.1:9999`
- **Token 头**：`x-api-token`
- **任务创建模式**：`tasks | batch | request`（在脚本 `GOPEED_CONFIG.createMode` 中配置）
- **文件名/保存路径**：优先使用 `opt.name`/`opt.path`（若你的 Gopeed 版本不支持，可改用 `request` 模式并仅传 `url`）

> 这样可以利用 Gopeed 的断点续传与失败重试能力，减少浏览器下载失败/重命名的问题。

### 6) 列表交互与队列提交

面板改为“**按日期分组 + 倒序**”展示，每个日期可展开查看课程：

- **下载整天**：日期行右侧按钮（队列提交）
- **下载单节**：每节课右侧按钮（队列提交）
- **日期解析更鲁棒**：兼容 `YYYY-MM-DD`、`YYYY/MM/DD`、`YYYY.MM.DD`、`YYYY年MM月DD日`

队列只负责“有序提交到 Gopeed”，不再等待浏览器下载完成：

- **并发限制**：默认 `2`（见脚本内 `__tmConcurrency`）
- **失败不降级**：不再打开后台页、不再使用带/不带参数的双链接重试

## 本地自检（最小可运行验证）

这是纯前端 userscript，最基础的自检是 **语法检查**：

- `node --check smartclass-downloader.user.js`

然后在浏览器里安装脚本，打开匹配页面 `https://tmu.smartclass.cn/PlayPages/Video.aspx*`，观察控制台日志与浮层面板行为即可。

## 提交（Conventional Commits 推荐）

建议采用：

- `feat(scope): ...` 新功能
- `fix(scope): ...` 修复
- `refactor(scope): ...` 重构（不改行为）
- `docs: ...` 文档

示例：`fix(token): 从网络请求捕获并缓存csrkToken`
