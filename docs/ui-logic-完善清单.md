# agent-app 界面与逻辑完善清单（历史归档）

> **2026-10-29 起**：以 Cursor / Harness 对齐为主线，请改看  
> → [`cursor-harness-对齐待办.md`](./cursor-harness-对齐待办.md)（性能 · 交互 · 工具循环）。  
> 本文保留 2026-10-26 审查结论，便于追溯；下列「代码复核」标注是否仍欠债。

> 审查范围：`src/`（页面 / 组件 / store / 服务 / 插件）、`htmls/` 原型对齐、Android 版本与打包相关 UX。  
> 日期：2026-10-26 · 当时版本参考：`1.0.12`（现基线见对齐待办）  
> 优先级：`P0` 必须修 · `P1` 尽快修 · `P2` 体验/一致性 · `P3` 打磨  

### 2026-10-29 代码复核（摘要）

| 原项 | 状态 |
| --- | --- |
| P0-1 默认 Key | ✅ 已空默认 |
| P0-2/3 写回路径 / modified | ✅ 沙盒队列 + `g.rel` |
| P0-4 项目编辑 hydrate | ✅ 已 watch loaded |
| P1-5 版本单一源 | ✅ `version.ts` + patch 注入 |
| P1-6 FTP 失败不清队列 | ✅ `removeModifiedFiles(done)` |
| P1-7/8 取消 / 防双发 | ✅ Abort + 入口加锁 |
| P1-9 Tab exact | ✅ `App.vue` exact / active class（1.0.24） |
| P1-10 allowBackup / 凭据 | ✅ Manifest 关 backup + 设置页说明 |
| P1-12 清空确认 | ✅ |
| P1-14 滚动/键盘 | ✅ 智能跟滚 + visualViewport（1.0.24） |
| P2-24 digest vs 会话 | ✅ 会话真源 + 清记忆 persist（1.0.24） |
| P1-15 删项目残留 | ✅ 可选清沙盒 + **清会话树**（1.0.27） |
| 其余增强 | ✅ 至 1.0.27：含 LLM 压缩上下文、远程递归拉取/删目录；主清单完成见对齐待办 |

---

## 总览

| 优先级 | 数量 | 主题 |
| --- | --- | --- |
| P0 | 4 | 默认密钥、写回路径错误、工作区路径不一致、项目编辑竞态覆盖 FTP |
| P1 | 11 | 版本不一致、上传清队列、无取消、双发、Tab 高亮、备份泄露、空态、确认、FTP 批处理、键盘/滚动、删除残留 |
| P2 | 19 | 设置保存、文案/原型漂移、FTP 能力缺口、会话列表占位、加载态、无障碍等 |
| P3 | 6 | 命名、emoji、返回键、滚动穿透等 |

**跨切面结论：**

1. **密钥与版本**：源码内嵌默认 API Key；设置页 / npm / APK 三套版本号。
2. **修改文件管线**：`trackModified`、本轮 `modifiedFiles`、`chat.lastModified` 三套真相源不一致，「写回手机」最危险。
3. **异步水合**：项目编辑页与 `projects.load()` 竞态，可能用空表单覆盖真实配置。
4. **长任务**：Agent / 媒体无取消；FTP 批量失败被吞后仍清队列。
5. **htmls vs Vue**：对话 FAB/弹框基本对齐；首页 / 设置 / 项目文案仍偏旧。

---

## P0 · 必须修复

### 1. 默认配置硬编码真实 API Key
- **模块**：设置 / 全局
- **证据**：`src/stores/agentSettings.ts` → `defaultConfig()` 中 `apiKey: 'sk-ar-…'`（Preferences 解析失败也会回落到该默认）
- **影响**：首装或存储损坏会把密钥打进客户端；密钥已暴露在仓库
- **建议**：默认置空；仓库轮换已泄露 Key；首次引导用户填写

### 2. 「写回手机」优先用本轮 `lastModified`，非累计修改列表
- **模块**：对话
- **证据**：`ChatView.vue` `exportToPhone`：有 `chat.lastModified` 就用之；`applyResult` 每轮**替换** `lastModified`；FTP 上传走 `getModifiedFiles()`
- **影响**：多轮修改只写回最后一轮；写回与 FTP 行为不一致
- **建议**：写回统一读沙盒 `.modified.json`（或合并），不要用单轮列表顶替累计列表

### 3. Agent 循环记录的是工具原始 `path`，不是落盘相对路径
- **模块**：对话 / Agent
- **证据**：`agentLoop.ts` 中 `modified.add(String(args.path))`，而 `trackModified` 用的是 `resolveScopedPath` 后的 `g.rel`
- **影响**：工作区为 `src` 时，写回可能找 `foo.ts`，沙盒实为 `src/foo.ts` → 静默漏写
- **建议**：`modified` 一律 push `g.rel`

### 4. 项目编辑页冷启动竞态：空表单可覆盖真实 FTP
- **模块**：项目
- **证据**：`ProjectEditView.vue` 仅在 setup 时 `if (project.value)` 填一次表；无 `watch`/`onMounted` 同步；`App.vue` 异步 `projects.load()`
- **影响**：深链/竞态下界面后出现但字段为空，点保存会抹掉 host/user/password
- **建议**：`project` 就绪后再 hydrate；未 hydrate 禁用保存

---

## P1 · 尽快修复

### 5. 版本号三处不一致
- **模块**：全局 / 打包
- **证据**：`package.json` `1.0.12`；`SettingsView.vue` / `htmls/settings.html` 写死 `1.0.7`；`android/app/build.gradle` `versionName "1.0"` / `versionCode 1`；CI 用 package 命名产物但不改 Gradle
- **影响**：关于页 / 商店 / APK 信息对不上
- **建议**：单一版本源，构建时注入 Gradle + 关于页

### 6. FTP 上传部分失败仍清空全部修改标记
- **模块**：对话
- **证据**：`ChatView.uploadModified` → `ftpUploadModifiedProject`（逐文件 try/catch 返回子集）后**无条件** `clearModifiedFiles`
- **影响**：失败文件被当成已上传，队列丢失
- **建议**：只清除实际上传成功的路径

### 7. Agent / 斜杠长任务无取消
- **模块**：对话
- **证据**：`send()` 等待 `runAgentLoop` / `runSlashCommand`（视频轮询最长约 600s）；无 `AbortController`、无「停止」按钮
- **影响**：界面长期 busy；切页仍改 Pinia
- **建议**：停止按钮 + 中止 fetch/轮询

### 8. `busy` 置位前可双发
- **模块**：对话
- **证据**：`send()` 先检查再 `pushUser`/`beginAssistant`，最后才设 `busy`/`streaming`
- **影响**：连点可起两个循环
- **建议**：进入函数立刻加锁，再改消息列表

### 9. 首页 Tab 在非首页也常亮
- **模块**：壳层
- **证据**：`App.vue` `router-link to="/"`；样式用 `.router-link-active`（前缀匹配）
- **影响**：`/chat` 等页面「首页」与当前 Tab 双高亮
- **建议**：首页用 `.router-link-exact-active` 或自定义 `v-slot`

### 10. API Key / FTP 密码进 Preferences 且允许备份
- **模块**：设置 / 项目 / 安全
- **证据**：`@capacitor/preferences`；`AndroidManifest.xml` `android:allowBackup="true"`
- **影响**：云备份/换机可能带出凭据
- **建议**：排除敏感 prefs 或加密；文档标明风险

### 11. 项目 id 无效时空白页无恢复
- **模块**：项目
- **证据**：`ProjectEditView.vue` 仅 `v-if="project"`，无 else
- **影响**：坏书签 → 白屏 + 底栏
- **建议**：「项目不存在」+ 回项目列表

### 12. 「清空当前会话」无确认
- **模块**：对话
- **证据**：弹框内直接 `@click="chat.clear()"`；删会话/消息有 `confirm`
- **影响**：易误触清空消息与 lastModified
- **建议**：与其它破坏操作一致加确认

### 13. FTP 批量上传/拉取吞错且文案偏乐观
- **模块**：文件
- **证据**：`FtpBrowserView` `batchUploadDir` / `batchPullDir` 空 `catch`；成功文案 `已上传 ${ok}/${files.length}` 无失败明细
- **影响**：用户以为全成功
- **建议**：汇总跳过原因 / 失败文件名

### 14. 对话无滚到底、无键盘避让
- **模块**：对话 / UX
- **证据**：无 `scrollIntoView`；输入条仅 `bottom: calc(64px + safe-area)`
- **影响**：新回复与软键盘挡住内容
- **建议**：流式时滚动；Keyboard / `visualViewport` 抬高 dock

### 15. 删除项目不清理沙盒与会话目录
- **模块**：项目
- **证据**：`projects.removeProject` 只改 Preferences 列表
- **影响**：残留数据，「删除」心智不符
- **建议**：可选清理沙盒+会话树，或文案说明仍保留

---

## P2 · 体验与一致性

| # | 模块 | 问题 | 证据要点 | 建议方向 |
| --- | --- | --- | --- | --- |
| 16 | 设置 | 高级 Max Tokens / Temperature / 系统提示不自动保存 | 保存按钮在 API 卡片；离开即丢 | 脏态提示 / 失焦保存 / 统一保存 |
| 17 | 设置 | 存储路径成功也用 `err` 样式 | 首张存储卡 `rootMsg` 类名固定 `err` | 按结果切 `ok`/`err` |
| 18 | 项目 | `passive` / `secure` 有模型无 UI | `FtpConfig` + 插件有，编辑页无开关 | 暴露 FTPS/被动模式 |
| 19 | 项目 | 无 FTP「测试连接」 | AI 有测连，FTP 无 | 列表/连接探测 |
| 20 | 文件 | 「全部拉取」仅当前目录文件；「全部上传」递归 | `batchPullDir` vs `listLocalFilesRecursive` | 行为对齐或改文案 |
| 21 | 文件 | 可建目录不可删目录 | `deleteLocal`/`deleteRemote` 遇目录直接 return | 递归删除 + 确认 |
| 22 | 对话 | 失败回合留下空助手气泡 | catch 仍 persist；无 content 时气泡空 | 写入错误文案或删占位 |
| 23 | 对话 | 消息静默截断 100 条 | `chatSessionFs.ts` `MAX_MESSAGES = 100` | UI 提示或分页抬限 |
| 24 | 对话 | harness 记忆在 `localStorage`，会话在目录树 | `harness.ts` vs 会话文件 | 记忆跟会话文件存 |
| 25 | 对话 | 会话列表常驻占上方 | `session-card` 在主列 | 折叠 / 进弹框 / 二级页 |
| 26 | 全局 | store 引导无加载态 | `App.vue` 加载；视图不看 `loaded` | 骨架屏 / 门禁 |
| 27 | 首页 | 仍写「绑定 Agent 服务器」 | `HomeView` 空态文案 | 对齐全局设置流程 |
| 28 | 对话 | 斜杠命令可能与当前「对话模型」不匹配 | UI 推 `/img` `/video`；走媒体端点 | 按能力展示或文案提示 |
| 29 | 无障碍 | 弹层无焦点陷阱；背景未 `aria-hidden` | Vue sheet 弱于 htmls 原型 | 对齐原型 a11y |
| 30 | 对话 | 消息 id 用 `Date.now()` | `pushUser` / `beginAssistant` | uuid / 单调计数 |
| 31 | 打包 | `package-lock.json` 版本可能滞后 | lock 与 package 不一致时 | 升版本时同步 lock |
| 32 | 原型 | projects/index 文案过时 | 仍写项目内配 Agent | 同步或标 deprecated |
| 33 | 项目编辑 | Vue 无返回项目列表链 | htmls 有「← 返回」 | 加顶栏返回 |
| 34 | 设置原型 | htmls 缺会话存储目录块 | Vue 强制先选存储 | 补齐 hardest onboarding |

---

## P3 · 打磨

| # | 模块 | 问题 | 建议 |
| --- | --- | --- | --- |
| 35 | 壳层 | Tab「文件」vs 标题「文件管理」/ 产品「FTP」 | 统一产品用语 |
| 36 | 多页 | 装饰 emoji（📁 等）干扰读屏 | `aria-hidden` |
| 37 | Capacitor | 明文流量 / mixed content | 文档标明 LAN HTTP 有意为之 |
| 38 | 对话 / 文件 | 弹层未锁背景滚动 | 打开时 `overflow: hidden` |
| 39 | 项目 | 列表无快捷删除、空态 CTA 偏薄 | 可选增强 |
| 40 | 壳层 | 依赖含 StatusBar / App 但未用返回栈 | 物理返回优先关弹层 |

---

## 建议修复顺序

1. **立刻**：P0-1 去掉默认 Key 并轮换；P0-2/3 统一修改文件路径与写回源；P0-4 项目表单 hydrate。
2. **本迭代**：P1-5 版本单一源；P1-6/7/8 上传清队列、取消、防双发；P1-9 Tab 精确激活；P1-12 清空确认。
3. **下一迭代**：P1 键盘滚动与 FTP 批处理；P2 设置保存、FTP 测连与能力开关、会话列表收纳、htmls 对齐。
4. **持续打磨**：P3 命名、返回键、无障碍。

---

## 不在本次范围

- 纯样式微调、字体微调（除非影响可读/可点）
- 服务端 / `agent/` 仓库逻辑（除非客户端契约错误）
- 漏洞利用步骤（仅记录产品侧数据安全风险）
