/** Harness 对齐：上游 OpenAI 兼容 API 配置（全局共用） */
export interface AgentServerConfig {
  /** 上游 API 地址，如 https://ai.1k0.com/v1 */
  apiBaseUrl: string;
  /** API Key（Bearer Token） */
  apiKey: string;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  toolsEnabled?: boolean;
}

/** FTP 连接配置 */
export interface FtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  /** 远程站点根目录（FTP 上的项目路径） */
  remoteRoot: string;
  passive: boolean;
  /** 是否使用 FTPS */
  secure: boolean;
}

/** 本地工作区项目 */
export interface WorkProject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Capacitor Directory URI 或 SAF document tree URI */
  localRootUri: string;
  localRootLabel: string;
  /** @deprecated 已迁移到全局 AI 设置 */
  agent?: AgentServerConfig;
  ftp: FtpConfig;
  /** 远程路径 ↔ 本地相对路径 映射前缀（可选） */
  pathPrefix?: string;
  /** 项目级 Rules（优先于自动读取的 AGENTS.md） */
  rules?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  createdAt: string;
}

/** 会话元数据（列表展示；正文在独立 messages 文件） */
export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 首条用户消息摘要，便于列表展示 */
  preview?: string;
  messageCount?: number;
}

export interface ChatSessionData {
  messages: ChatMessage[];
  lastModified: string[];
  /** 会话级工具记忆（与消息一并落盘） */
  harnessDigest?: HarnessDigest;
}

export interface ToolLogEntry {
  name: string;
  label: string;
  ok: boolean;
  path?: string;
  /** 写入类工具行数统计（对齐 Harness 写入轨迹） */
  added?: number;
  removed?: number;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

/* ------------------------------------------------------------------ *
 * Harness 式对话面板：分析 / 读取编辑 / 思考 / 任务 / 修改文件
 * 一次对话（turn）内各板块随 AI 接口结果不断追加记录与状态。
 * ------------------------------------------------------------------ */

/** 分析阶段（对齐 Harness 的 Explore / Plan / Implement / Verify） */
export type HarnessPhase = 'analysis' | 'read' | 'edit' | 'verify';

export const HARNESS_PHASE_LABEL: Record<HarnessPhase, string> = {
  analysis: '分析',
  read: '读取',
  edit: '编辑',
  verify: '校验',
};

export interface HarnessAnalysisEntry {
  id: string;
  phase: HarnessPhase;
  at: number;
  /** 一句话结论 / 事件描述 */
  text: string;
  /** 关联文件或搜索目标 */
  path?: string;
  /** 该阶段新增/失败的工具次数（UI 折叠展示） */
  count?: number;
  ok?: boolean;
}

export interface HarnessFileChange {
  path: string;
  /** write=新建/整写，replace=局部替换，delete=删除 */
  kind: 'write' | 'replace' | 'delete';
  added?: number;
  removed?: number;
  at: number;
}

export interface HarnessTodoGroup {
  inProgress: TodoItem[];
  pending: TodoItem[];
  completed: TodoItem[];
}

/** 一次对话（一条用户消息 → Assistant 结束）的完整面板快照 */
export interface HarnessTurnPanels {
  turnId: string;
  startedAt: number;
  endedAt?: number;
  /** 用户原始输入 */
  prompt: string;
  analysis: HarnessAnalysisEntry[];
  /** 思考结果（按轮次聚合的 reasoning） */
  thinking: string[];
  todos: TodoItem[];
  files: HarnessFileChange[];
  /** 本轮工具统计 */
  toolCount: number;
  readCount: number;
  writeCount: number;
  /** 是否全部任务项已完成 */
  allDone: boolean;
  /** 异常/中断说明 */
  error?: string;
}

export type TimelineItemKind = 'thinking' | 'tool_start' | 'tool' | 'todos' | 'round';

/** 本轮 Harness 式时间线条目 */
export interface TimelineItem {
  id: string;
  kind: TimelineItemKind;
  at: number;
  /** thinking 文本 / 工具 label / 轮次说明 */
  text?: string;
  name?: string;
  path?: string;
  ok?: boolean;
  added?: number;
  removed?: number;
  active?: boolean;
  todos?: TodoItem[];
}

/** 本轮文件改动片段（审阅用） */
export interface FileDiffSnippet {
  path: string;
  kind: 'write' | 'replace' | 'delete';
  before?: string;
  after?: string;
  unified?: string;
  added?: number;
  removed?: number;
}

export interface HarnessDigest {
  modified_files: string[];
  read_files: string[];
  grep_keys: string[];
}

export interface AgentTurnResult {
  content: string;
  reasoning?: string;
  model?: string;
  toolLog: ToolLogEntry[];
  modifiedFiles: string[];
  fileDiffs?: FileDiffSnippet[];
  harnessDigest?: HarnessDigest;
  /** 本轮 Harness 面板快照（分析/思考/任务/修改文件） */
  panels?: HarnessTurnPanels;
}

export interface FtpEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: string;
}
