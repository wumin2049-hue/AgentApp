# ABS Agent App

移动端 AI 编程助手：**多项目**、**手机本地目录**读写、**与 `agent/` 共用接口配置**、**FTP 一键上传**与远程文件管理。

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| UI | Vue 3 + TypeScript + Pinia | 与现有 Web 技术栈一致，便于移植 `relay.js` 逻辑 |
| 原生壳 | **Capacitor 6** | 官方 Android 工程，可用 **GitHub Actions** 打 APK |
| 本地文件 | `@capacitor/filesystem` + `@capawesome/capacitor-file-picker` | 选择手机目录、沙盒读写 |
| FTP | 自定义 Capacitor 插件 `AgentFtp` | 基于 Apache Commons Net（见 `android-native/FtpPlugin.kt`） |

> 为何选 Capacitor 而非 Flutter：与 `agent/assets/js` 同语言，接口客户端可直接对齐；CI 用 `gradlew assembleDebug` 成熟稳定。

## 架构

```
┌─────────────┐   CapacitorHttp    ┌──────────────────┐
│  agent-app  │ ─────────────────► │ OpenAI 兼容上游   │
│  (手机)     │  chat/completions  │（全局 Harness 配置）│
└──────┬──────┘                    └──────────────────┘
       │ read_file / write_file / search_replace（本地循环）
       ▼
  手机沙盒 + 授权目录（SAF）
       │
       │ FTP 上传（仅变更文件）
       ▼
  远程虚拟主机
```

- **模型调用**：全局设置中的 API Base + Key，经原生 HTTP 直连上游（OpenAI 兼容）
- **文件工具**：在 **App 本地**执行 harness 工具循环，不把整仓上传到服务器
- **配置**：全局 Harness（API/模型）+ 每项目本地目录 / FTP；会话 Preferences 双写

## 功能清单（MVP）

- [x] 多项目管理（Preferences 持久化）
- [x] 选择手机文件夹作为工作区
- [x] Agent 对话 + 本地工具循环（read/write/grep/list/glob）
- [x] 记录修改文件 → **FTP 一键上传**
- [x] FTP 目录浏览（需原生插件）
- [x] GitHub Actions 自动打 Debug APK
- [x] SAF 目录树导入到沙盒（`AgentProjectStorage` 原生插件）
- [x] relay SSE 流式输出（`chatTurnStream`）
- [x] 对话历史保留（多轮上下文 + Preferences 持久化）
- [x] 沙盒修改写回手机目录（`exportFiles`）
- [x] 斜杠命令 `/img` `/img-async` `/video` `/video-quote`（经 relay）
- [x] 思考过程折叠展示 + 消息内图片预览

## 本地开发

```bash
cd agent-app
npm install
npm run dev          # 浏览器预览（FTP/部分文件 API 不可用）
npm run build
npx cap add android  # 首次
npx cap sync android
npx cap open android # Android Studio
```

真机调试 APK：

```bash
npm run android:debug
# 输出：android/app/build/outputs/apk/debug/app-debug.apk
```

## 安装原生插件（真机必做）

```bash
npx cap add android          # 首次
npm run android:patch        # 复制 FtpPlugin + ProjectStoragePlugin 并注册
npx cap sync android
```

脚本 `scripts/patch-android.mjs` 会自动：

1. 复制 `android-native/*.java`（优先）→ `android/app/src/main/java/com/abs/agentapp/`
2. 在 `app/build.gradle` 添加 `commons-net` + `documentfile`，并注入版本号
3. 在 `MainActivity` 注册 `FtpPlugin` 与 `ProjectStoragePlugin`

手动安装时，两个插件都需在 `MainActivity` 中 `registerPlugin(...)`。

## GitHub Actions 打 APK

本仓库为独立 Git 项目，工作流在 `.github/workflows/`：

| 文件 | 用途 |
| --- | --- |
| `android-apk.yml` | push main / 手动触发 → Debug 或 Release APK |
| `release.yml` | push 标签 `v*` → Release APK + GitHub Release |

**首次推送到 GitHub**（在 `agent-app` 目录内）：

```bash
cd agent-app
git init -b main
git add .
git commit -m "init mincode"
git remote add origin https://github.com/<用户>/<仓库>.git
git push -u origin main
```

**手动触发打包**：

```bash
gh auth login
npm run gh:apk:trigger              # debug
npm run gh:apk:trigger:release      # release
npm run gh:apk:watch
npm run gh:apk:latest
```

**发布正式版**：

```bash
npm run release:tag 1.0.3
git push origin main
git push origin v1.0.3
```

Release 构建需在仓库 **Settings → Secrets and variables → Actions** 配置：

| Secret | 说明 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 your.keystore` 输出 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 密钥别名 |
| `ANDROID_KEY_PASSWORD` | 密钥密码 |

## 与 agent/ 的配置对应

| 网页 agent | agent-app 项目配置 |
| --- | --- |
| 设置 → API 地址 | `Agent 站点 URL`（如 `https://域名/agent`） |
| Agent ID | `agentId` |
| 默认模型 | `model` |
| 访问密码 | `accessPassword` |
| tools.root（服务器项目根） | 手机本地目录 + FTP `remoteRoot` |

接口文档：

- [agent/docs/relay-api.md](../agent/docs/relay-api.md)
- [agent/docs/image-video-api.md](../agent/docs/image-video-api.md)

## 目录结构

```
agent-app/
├── src/
│   ├── api/agentServer.ts    # relay / chat 客户端
│   ├── services/
│   │   ├── agentLoop.ts      # 本地工具循环
│   │   └── localFs.ts        # 沙盒文件读写
│   ├── plugins/
│   │   ├── ftp/              # FTP Capacitor 插件
│   │   └── project-storage/  # SAF → 沙盒同步
│   ├── stores/               # 项目 / 对话状态
│   └── views/                # 页面
├── android-native/           # 原生插件模板（FTP + ProjectStorage）
├── scripts/patch-android.mjs # cap add 后一键安装插件
└── .github/workflows/          # CI 打包（android-apk.yml / release.yml）
```

## 安全提示

- FTP 密码、API 访问密码保存在手机 **Preferences**（未加密）；生产建议用系统 Keychain 插件加密
- 勿在公共仓库提交含真实 FTP/API 密钥的导出配置

## 文档

| 文档 | 说明 |
| --- | --- |
| [docs/cursor-harness-对齐待办.md](./docs/cursor-harness-对齐待办.md) | **当前主待办**：对齐 Cursor / Harness（性能 · 交互 · 工具循环） |
| [docs/ui-logic-完善清单.md](./docs/ui-logic-完善清单.md) | 2026-10-26 UI/逻辑审查归档 |

## 后续路线

1. 按 [Cursor / Harness 对齐待办](./docs/cursor-harness-对齐待办.md) 推进流式性能、diff 审阅、digest 统一、计划门闸等
2. 完整目录同步：手机选定文件夹 ↔ 沙盒双向同步
3. Release 签名 APK / AAB 上架（标签 `v*` 已走 `release.yml`）
