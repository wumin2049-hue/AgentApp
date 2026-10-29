import { Preferences } from '@capacitor/preferences';
import {
  writeTreeText,
  readTreeText,
  deleteTreePath,
  listTreeDir,
} from '@/plugins/project-storage';
import type { ChatMessage, ChatSessionData, ChatSessionMeta } from '@/types';

export const MAX_MESSAGES = 100;

export interface ChatStorageRoot {
  uri: string;
  label: string;
}

export interface ProjectSessionIndex {
  sessions: ChatSessionMeta[];
  activeSessionId: string;
}

function projectIndexPath(projectId: string): string {
  return `${projectId}/index.json`;
}

function sessionMessagesPath(projectId: string, sessionId: string): string {
  return `${projectId}/${sessionId}/messages.json`;
}

/** Preferences 兜底：SAF 写 json 曾被改成 .json.txt 导致读空，重启只剩「新会话」 */
function prefsIndexKey(projectId: string): string {
  return `abs_chat_idx_v2_${projectId}`;
}

function prefsSessionKey(projectId: string, sessionId: string): string {
  return `abs_chat_msg_v2_${projectId}_${sessionId}`;
}

function previewFromMessages(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user' && m.content.trim());
  if (!first) return '';
  const t = first.content.trim().replace(/\s+/g, ' ');
  return t.length > 48 ? `${t.slice(0, 48)}…` : t;
}

function titleFromMessages(messages: ChatMessage[], fallback: string): string {
  const p = previewFromMessages(messages);
  return p || fallback;
}

function parseIndex(raw: string): ProjectSessionIndex | null {
  try {
    const data = JSON.parse(raw) as Partial<ProjectSessionIndex>;
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    return {
      sessions,
      activeSessionId: typeof data.activeSessionId === 'string' ? data.activeSessionId : '',
    };
  } catch {
    return null;
  }
}

function parseSessionData(raw: string): ChatSessionData | null {
  try {
    const data = JSON.parse(raw) as Partial<ChatSessionData>;
    return {
      messages: Array.isArray(data.messages) ? data.messages : [],
      lastModified: Array.isArray(data.lastModified) ? data.lastModified : [],
      harnessDigest: data.harnessDigest,
    };
  } catch {
    return null;
  }
}

function indexScore(index: ProjectSessionIndex | null): number {
  if (!index?.sessions?.length) return 0;
  let score = index.sessions.length * 10;
  for (const s of index.sessions) {
    score += Math.max(0, s.messageCount || 0);
    if (s.preview) score += 1;
  }
  return score;
}

function sessionScore(data: ChatSessionData | null): number {
  if (!data) return 0;
  return (data.messages?.length || 0) * 10 + (data.lastModified?.length || 0);
}

async function prefsWrite(key: string, value: string): Promise<void> {
  await Preferences.set({ key, value });
}

async function prefsRead(key: string): Promise<string | null> {
  const r = await Preferences.get({ key });
  return r.value || null;
}

async function prefsRemove(key: string): Promise<void> {
  try {
    await Preferences.remove({ key });
  } catch {
    /* ignore */
  }
}

export function newSessionMeta(partial?: Partial<ChatSessionMeta>): ChatSessionMeta {
  const now = new Date().toISOString();
  return {
    id: partial?.id || `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: partial?.title || '新会话',
    createdAt: partial?.createdAt || now,
    updatedAt: partial?.updatedAt || now,
    preview: partial?.preview || '',
    messageCount: partial?.messageCount ?? 0,
  };
}

export async function readProjectIndex(
  root: ChatStorageRoot,
  projectId: string,
): Promise<ProjectSessionIndex | null> {
  let fromDisk: ProjectSessionIndex | null = null;
  try {
    const raw = await readTreeText(root.uri, projectIndexPath(projectId));
    fromDisk = parseIndex(raw);
  } catch {
    fromDisk = null;
  }

  let fromPrefs: ProjectSessionIndex | null = null;
  try {
    const raw = await prefsRead(prefsIndexKey(projectId));
    if (raw) fromPrefs = parseIndex(raw);
  } catch {
    fromPrefs = null;
  }

  if (!fromDisk && !fromPrefs) return null;
  if (!fromDisk) return fromPrefs;
  if (!fromPrefs) return fromDisk;
  return indexScore(fromPrefs) > indexScore(fromDisk) ? fromPrefs : fromDisk;
}

export async function writeProjectIndex(
  root: ChatStorageRoot,
  projectId: string,
  index: ProjectSessionIndex,
): Promise<void> {
  const json = JSON.stringify(index, null, 2);
  // Preferences 先写：即使 SAF 失败，重启也能恢复会话列表
  await prefsWrite(prefsIndexKey(projectId), json);
  try {
    await writeTreeText(root.uri, projectIndexPath(projectId), json);
  } catch {
    /* SAF 失败时 Preferences 已保存 */
  }
}

export async function readSessionData(
  root: ChatStorageRoot,
  projectId: string,
  sessionId: string,
): Promise<ChatSessionData> {
  let fromDisk: ChatSessionData | null = null;
  try {
    const raw = await readTreeText(root.uri, sessionMessagesPath(projectId, sessionId));
    fromDisk = parseSessionData(raw);
  } catch {
    fromDisk = null;
  }

  let fromPrefs: ChatSessionData | null = null;
  try {
    const raw = await prefsRead(prefsSessionKey(projectId, sessionId));
    if (raw) fromPrefs = parseSessionData(raw);
  } catch {
    fromPrefs = null;
  }

  const empty: ChatSessionData = { messages: [], lastModified: [] };
  if (!fromDisk && !fromPrefs) return empty;
  if (!fromDisk) return fromPrefs || empty;
  if (!fromPrefs) return fromDisk;
  return sessionScore(fromPrefs) > sessionScore(fromDisk) ? fromPrefs : fromDisk;
}

export async function writeSessionData(
  root: ChatStorageRoot,
  projectId: string,
  sessionId: string,
  data: ChatSessionData,
): Promise<void> {
  const payload: ChatSessionData = {
    messages: data.messages.slice(-MAX_MESSAGES),
    lastModified: data.lastModified,
    harnessDigest: data.harnessDigest,
  };
  const json = JSON.stringify(payload, null, 2);
  await prefsWrite(prefsSessionKey(projectId, sessionId), json);
  try {
    await writeTreeText(
      root.uri,
      sessionMessagesPath(projectId, sessionId),
      json,
    );
  } catch {
    /* SAF 失败时 Preferences 已保存 */
  }
}

export async function deleteSessionDir(
  root: ChatStorageRoot,
  projectId: string,
  sessionId: string,
): Promise<void> {
  await prefsRemove(prefsSessionKey(projectId, sessionId));
  try {
    await deleteTreePath(root.uri, `${projectId}/${sessionId}`);
  } catch {
    /* ignore */
  }
}

export function bumpSessionMeta(
  meta: ChatSessionMeta,
  messages: ChatMessage[],
): ChatSessionMeta {
  const now = new Date().toISOString();
  const preview = previewFromMessages(messages);
  const keepCustomTitle = meta.title && meta.title !== '新会话' && !meta.title.startsWith('会话 ');
  return {
    ...meta,
    updatedAt: now,
    preview,
    messageCount: messages.length,
    title: keepCustomTitle ? meta.title : titleFromMessages(messages, meta.title || '新会话'),
  };
}

/** 确保项目下至少有一个会话，返回 index + 当前 session 数据 */
export async function ensureProjectSessions(
  root: ChatStorageRoot,
  projectId: string,
  migrateMessages?: ChatMessage[],
  migrateLastModified?: string[],
): Promise<{ index: ProjectSessionIndex; data: ChatSessionData }> {
  let index = await readProjectIndex(root, projectId);
  if (!index || !index.sessions.length) {
    const meta = newSessionMeta({
      title: migrateMessages?.length ? titleFromMessages(migrateMessages, '会话 1') : '新会话',
      preview: migrateMessages?.length ? previewFromMessages(migrateMessages) : '',
      messageCount: migrateMessages?.length || 0,
    });
    index = { sessions: [meta], activeSessionId: meta.id };
    const data: ChatSessionData = {
      messages: migrateMessages || [],
      lastModified: migrateLastModified || [],
    };
    await writeSessionData(root, projectId, meta.id, data);
    await writeProjectIndex(root, projectId, index);
    return { index, data };
  }

  let activeId = index.activeSessionId;
  if (!index.sessions.some((s) => s.id === activeId)) {
    activeId = index.sessions[0].id;
    index = { ...index, activeSessionId: activeId };
    await writeProjectIndex(root, projectId, index);
  }

  const data = await readSessionData(root, projectId, activeId);

  // 若磁盘侧曾写丢，用 Preferences 内容回填 SAF
  if (data.messages.length > 0) {
    void writeSessionData(root, projectId, activeId, data);
    void writeProjectIndex(root, projectId, index);
  }

  return { index, data };
}

export async function listSessionDirs(
  root: ChatStorageRoot,
  projectId: string,
): Promise<string[]> {
  try {
    return await listTreeDir(root.uri, projectId);
  } catch {
    return [];
  }
}
