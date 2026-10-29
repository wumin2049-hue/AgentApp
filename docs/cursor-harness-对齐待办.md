# agent-app × Cursor / Harness 对齐待办

> 目标：对话、工具循环、性能与交互向 **Cursor Agent Harness** 靠拢（移动端取舍）。  
> 基线版本：`package.json` **1.0.27** · 更新：2026-10-29  
> 旧清单：[`ui-logic-完善清单.md`](./ui-logic-完善清单.md)

---

## 状态：清单已全部落地

两份 MD 中的 **P0/P1、H0～H3 主项与可选增强**均已实现（远程递归能力与 LLM 摘要入口含在内）。

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
| Rules / 计划 / diff | 见既有索引 |

---

## 4. 状态栏

- [x] 全部主项与可选增强
