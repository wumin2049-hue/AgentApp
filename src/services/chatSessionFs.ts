import {
  writeTreeText,
  readTreeText,
  deleteTreePath,
  listTreeDir,
} from '@/plugins/project-storage';
import type { ChatMessage, ChatSessionData, ChatSessionMeta } from '@/types';

const MAX_MESSAGES = 100;

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
  try {
    const raw = await readTreeText(root.uri, projectIndexPath(projectId));
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

export async function writeProjectIndex(
  root: ChatStorageRoot,
  projectId: string,
  index: ProjectSessionIndex,
): Promise<void> {
  await writeTreeText(root.uri, projectIndexPath(projectId), JSON.stringify(index, null, 2));
}

export async function readSessionData(
  root: ChatStorageRoot,
  projectId: string,
  sessionId: string,
): Promise<ChatSessionData> {
  try {
    const raw = await readTreeText(root.uri, sessionMessagesPath(projectId, sessionId));
    const data = JSON.parse(raw) as Partial<ChatSessionData>;
    return {
      messages: Array.isArray(data.messages) ? data.messages : [],
      lastModified: Array.isArray(data.lastModified) ? data.lastModified : [],
    };
  } catch {
    return { messages: [], lastModified: [] };
  }
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
  };
  await writeTreeText(
    root.uri,
    sessionMessagesPath(projectId, sessionId),
    JSON.stringify(payload, null, 2),
  );
}

export async function deleteSessionDir(
  root: ChatStorageRoot,
  projectId: string,
  sessionId: string,
): Promise<void> {
  await deleteTreePath(root.uri, `${projectId}/${sessionId}`);
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
