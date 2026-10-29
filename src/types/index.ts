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
}

/** 本轮文件改动片段（审阅用） */
export interface FileDiffSnippet {
  path: string;
  kind: 'write' | 'replace' | 'delete';
  before?: string;
  after?: string;
  unified?: string;
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
}

export interface FtpEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: string;
}
