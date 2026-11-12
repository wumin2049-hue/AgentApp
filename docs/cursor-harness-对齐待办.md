# agent-app × Cursor / Harness 对齐待办

> 目标：对话、工具循环、性能与交互向 **Cursor Agent Harness** 靠拢（移动端取舍）。  
> 基线版本：`package.json` **1.0.33** · 更新：2026-11-04  
> 旧清单：[`ui-logic-完善清单.md`](./ui-logic-完善清单.md)

---

## 状态：清单已全部落地 + 1.0.28 补洞

两份 MD 中的 **P0/P1、H0～H3 主项与可选增强**均已实现（远程递归能力与 LLM 摘要入口含在内）。

### 1.0.28 · 空目录 0→1 / 「只出计划不落盘」

对齐 `agent/lib/agent_loop.php` 的编辑追问：模型在探查（含 `list_dir` 空目录）后若只输出计划/代码块且未 `write_file`，不再直接结束，而是 `editNudge` → 强制写入工具继续，直到落盘或追问用尽。

### 1.0.29 · 实时写入手机（对齐 Cursor 工作区）

`write_file` / `search_replace` 每次调用立即写入绑定的手机 SAF 目录（自动建父目录），并镜像沙盒；一回合可连续写入多文件搭架构。失败时才进入「补写回手机」队列。

### 1.0.30 · 强制落盘 / 无 tool_calls 兜底

创建类任务首轮 `tool_choice=required`；编辑意图未落盘一律追问（不再要求「像计划」）；解析正文里的伪 tool_call；markdown 带路径代码块直接写入手机。

### 1.0.32 · ask_user 弹框 + 未落盘持续跑

中转站自定义 API URL/Key 直连工具循环；新增 `ask_user` 与正文方案识别弹框；编辑任务在写入成功或轮次用尽前不会因「只回文字」提前结束。

### 1.0.33 · Harness 时间线 · 写入 · 任务清单

对话页时间线展示思考 / 写入(+N -M) / 工具；`update_todos` 驱动底部任务面板；长任务显示已用时。

### 1.0.36 · Harness 式四板块对话面板

把单条时间线拆成**并列四板块**，每块各自随 AI 接口结果不断追加记录与状态：

| 板块 | 内容 | 数据来源 |
| --- | --- | --- |
| ① 分析 · 读取 · 编辑记录 | 按 `分析 / 读取 / 编辑 / 校验` 分组累积，同类连续条目合并计数 | 工具调用 + 意图识别 |
| ② 思考结果 | 每轮 reasoning 分条，可展开/收起 | 流式 `reasoning_content` |
| ③ 任务列表 | **进行中 / 待完成 / 已完成** 三段分组 | `update_todos` |
| ④ 本次修改的文件 | 路径 + 写入/替换/删除 标记 + 行增删 | `write_file` / `search_replace` / `delete_file` |

- 新增 `src/services/turnPanels.ts`：面板快照聚合器（`recordTool` / `recordThinking` / `recordTodos` / `finishTurnPanels`）
- 新增 `src/components/HarnessPanels.vue`：四板块 UI（各自折叠）
- `agentLoop` 新增 `panels` 事件，`AgentTurnResult.panels` 带回完整快照
- 一次对话结束即归档到 `chat.turnPanelsHistory`，顶部「本轮记录 #N」可回看历史执行
- 任务必须逐项按序完成：清单未完成时结束会在「分析记录」落一条 `ok=false` 的未完成提示

---

## 1. 对齐原则

| 维度 | Cursor / Harness | agent-app |
| --- | --- | --- |
| Harness | Instructions + Tools + Model | 全局 API/模型 + 工具 + 项目 Rules |
| 工具循环 | 可停 / 并行读 / 审批 / 计划 | ✅ 计划门闸、删确认、只读并行 |
| 上下文 | 裁剪与摘要 | ✅ prune + **可点「压缩上下文」LLM/规则摘要** |
| 交互 | 流式、跟滚、审阅 | ✅ 流式节流、智能跟滚、行级 diff、@ |
| 性能 | 少掉帧 | ✅ 流式纯文本 → 定稿 MD |

---

## 2. 已完成

- [x] H0～H3 主项（见历史迭代 1.0.24～1.0.26）
- [x] H1-1+ 行级 LCS unified
- [x] H2-4+ 「压缩上下文」（LLM 优先，失败回退规则摘要）
- [x] H2-pull-deep 远程「递归拉取」（上限 300）
- [x] H2-remote-rm 远程目录递归删除（`removeDirectory` + JS 递归）
- [x] 删项目可选清理会话树 / 沙盒

---

## 3. 相关代码

| 能力 | 路径 |
| --- | --- |
| 会话压缩 | `src/services/sessionSummary.ts` · ChatView |
| 远程递归 | `src/plugins/ftp/index.ts` · FtpBrowserView · `FtpPlugin.java` |
| 删项目清会话 | `chat.purgeProjectSessions` · ProjectEditView |
| 四板块面板 | `src/services/turnPanels.ts` · `src/components/HarnessPanels.vue` · `agentLoop` 的 `panels` 事件 |
| Rules / 计划 / diff | 见既有索引 |

---

## 4. 状态栏

- [x] 全部主项与可选增强
