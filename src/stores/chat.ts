import { defineStore } from 'pinia';
import { Preferences } from '@capacitor/preferences';
import type { ChatMessage, AgentTurnResult, HarnessDigest, ToolLogEntry, ChatSessionMeta } from '@/types';
import { emptyDigest, loadHarnessDigest, saveHarnessDigest, clearHarnessDigest } from '@/services/harness';
import { useAgentSettingsStore } from '@/stores/agentSettings';
import {
  bumpSessionMeta,
  deleteSessionDir,
  ensureProjectSessions,
  MAX_MESSAGES,
  newSessionMeta,
  readSessionData,
  writeProjectIndex,
  writeSessionData,
  type ProjectSessionIndex,
} from '@/services/chatSessionFs';

function workRootKey(projectId: string): string {
  return `abs_chat_work_root_${projectId}`;
}

function legacyChatKey(projectId: string): string {
  return `abs_chat_${projectId}`;
}

let msgSeq = 0;
function nextMessageId(suffix = ''): string {
  msgSeq += 1;
  return `m_${Date.now().toString(36)}_${msgSeq}${suffix ? `_${suffix}` : ''}`;
}

function digestFromSession(data: { harnessDigest?: HarnessDigest }, projectId: string, sessionId: string): HarnessDigest {
  if (data.harnessDigest) return data.harnessDigest;
  return loadHarnessDigest(projectId, sessionId);
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    projectId: '' as string,
    sessionId: '' as string,
    sessions: [] as ChatSessionMeta[],
    workRoot: '' as string,
    messages: [] as ChatMessage[],
    streaming: false,
    toolLog: [] as ToolLogEntry[],
    lastModified: [] as string[],
    /** 本轮 AI 实际改动的文件（用于回复下方弹窗） */
    turnModifiedFiles: [] as string[],
    harnessDigest: emptyDigest() as HarnessDigest,
    error: '' as string,
    storageReady: false as boolean,
  }),

  getters: {
    activeSession(state): ChatSessionMeta | undefined {
      return state.sessions.find((s) => s.id === state.sessionId);
    },
    messageCap(): number {
      return MAX_MESSAGES;
    },
    nearMessageCap(state): boolean {
      return state.messages.length >= MAX_MESSAGES - 5;
    },
  },

  actions: {
    requireStorageRoot() {
      const settings = useAgentSettingsStore();
      if (!settings.hasChatStorageRoot || !settings.chatStorageRoot) {
        throw new Error('请先在「设置」中选择会话数据存储目录');
      }
      return settings.chatStorageRoot;
    },

    async loadForProject(projectId: string, force = false) {
      if (!projectId) return;
      if (!force && this.projectId === projectId && this.sessionId) return;

      this.projectId = projectId;
      this.toolLog = [];
      this.turnModifiedFiles = [];
      this.error = '';
      this.storageReady = false;

      const wr = await Preferences.get({ key: workRootKey(projectId) });
      this.workRoot = wr.value || '';

      const settings = useAgentSettingsStore();
      if (!settings.loaded) await settings.load();
      if (!settings.hasChatStorageRoot) {
        this.sessions = [];
        this.sessionId = '';
        this.messages = [];
        this.lastModified = [];
        this.harnessDigest = emptyDigest();
        return;
      }

      try {
        const root = this.requireStorageRoot();

        let migrateMessages: ChatMessage[] | undefined;
        let migrateLastModified: string[] | undefined;
        const legacy = await Preferences.get({ key: legacyChatKey(projectId) });
        if (legacy.value) {
          try {
            const data = JSON.parse(legacy.value) as {
              messages?: ChatMessage[];
              lastModified?: string[];
            };
            migrateMessages = data.messages || [];
            migrateLastModified = data.lastModified || [];
          } catch {
            /* ignore */
          }
        }

        const { index, data } = await ensureProjectSessions(
          root,
          projectId,
          migrateMessages,
          migrateLastModified,
        );

        if (legacy.value && migrateMessages?.length) {
          await Preferences.remove({ key: legacyChatKey(projectId) });
        }

        this.applyIndex(index);
        this.messages = data.messages;
        this.lastModified = data.lastModified;
        this.harnessDigest = digestFromSession(data, projectId, this.sessionId);
        this.storageReady = true;
      } catch (e) {
        this.sessions = [];
        this.sessionId = '';
        this.messages = [];
        this.lastModified = [];
        this.harnessDigest = emptyDigest();
        this.storageReady = false;
        this.error =
          e instanceof Error
            ? `会话存储不可用：${e.message}。请到设置重新选择数据目录。`
            : String(e);
      }
    },

    applyIndex(index: ProjectSessionIndex) {
      this.sessions = [...index.sessions].sort(
        (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''),
      );
      this.sessionId = index.activeSessionId;
    },

    async setWorkRoot(root: string) {
      this.workRoot = root.replace(/^\/+|\/+$/g, '');
      if (this.projectId) {
        await Preferences.set({ key: workRootKey(this.projectId), value: this.workRoot });
      }
    },

    async persist() {
      if (!this.projectId || !this.sessionId) return;
      const root = this.requireStorageRoot();
      await writeSessionData(root, this.projectId, this.sessionId, {
        messages: this.messages,
        lastModified: this.lastModified,
        harnessDigest: this.harnessDigest,
      });
      saveHarnessDigest(this.projectId, this.harnessDigest, this.sessionId);

      const idx = this.sessions.findIndex((s) => s.id === this.sessionId);
      if (idx >= 0) {
        this.sessions[idx] = bumpSessionMeta(this.sessions[idx], this.messages);
      }
      await writeProjectIndex(root, this.projectId, {
        sessions: this.sessions,
        activeSessionId: this.sessionId,
      });
      this.sessions = [...this.sessions].sort(
        (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''),
      );
    },

    async createSession() {
      if (!this.projectId) return;
      if (this.streaming) return;
      const root = this.requireStorageRoot();
      const meta = newSessionMeta({
        title: `会话 ${this.sessions.length + 1}`,
      });
      await writeSessionData(root, this.projectId, meta.id, {
        messages: [],
        lastModified: [],
      });
      this.sessions = [meta, ...this.sessions];
      this.sessionId = meta.id;
      this.messages = [];
      this.lastModified = [];
      this.toolLog = [];
      this.error = '';
      this.harnessDigest = emptyDigest();
      saveHarnessDigest(this.projectId, this.harnessDigest, this.sessionId);
      await writeProjectIndex(root, this.projectId, {
        sessions: this.sessions,
        activeSessionId: this.sessionId,
      });
      this.storageReady = true;
    },

    async switchSession(sessionId: string) {
      if (!this.projectId || sessionId === this.sessionId) return;
      if (this.streaming) return;
      const root = this.requireStorageRoot();
      if (!this.sessions.some((s) => s.id === sessionId)) return;

      await this.persist();

      const data = await readSessionData(root, this.projectId, sessionId);
      this.sessionId = sessionId;
      this.messages = data.messages;
      this.lastModified = data.lastModified;
      this.toolLog = [];
      this.error = '';
      this.harnessDigest = digestFromSession(data, this.projectId, sessionId);
      await writeProjectIndex(root, this.projectId, {
        sessions: this.sessions,
        activeSessionId: this.sessionId,
      });
    },

    async deleteSession(sessionId: string) {
      if (!this.projectId || this.streaming) return;
      const root = this.requireStorageRoot();
      const target = this.sessions.find((s) => s.id === sessionId);
      if (!target) return;

      await deleteSessionDir(root, this.projectId, sessionId);
      clearHarnessDigest(this.projectId, sessionId);
      this.sessions = this.sessions.filter((s) => s.id !== sessionId);

      if (!this.sessions.length) {
        const meta = newSessionMeta({ title: '新会话' });
        await writeSessionData(root, this.projectId, meta.id, {
          messages: [],
          lastModified: [],
        });
        this.sessions = [meta];
        this.sessionId = meta.id;
        this.messages = [];
        this.lastModified = [];
        this.toolLog = [];
        this.error = '';
        this.harnessDigest = emptyDigest();
        saveHarnessDigest(this.projectId, this.harnessDigest, this.sessionId);
      } else if (this.sessionId === sessionId) {
        const next = this.sessions[0];
        this.sessionId = next.id;
        const data = await readSessionData(root, this.projectId, next.id);
        this.messages = data.messages;
        this.lastModified = data.lastModified;
        this.toolLog = [];
        this.error = '';
        this.harnessDigest = digestFromSession(data, this.projectId, next.id);
      }

      await writeProjectIndex(root, this.projectId, {
        sessions: this.sessions,
        activeSessionId: this.sessionId,
      });
    },

    async deleteMessage(messageId: string) {
      if (!messageId || this.streaming) return;
      const before = this.messages.length;
      this.messages = this.messages.filter((m) => m.id !== messageId);
      if (this.messages.length === before) return;
      await this.persist();
    },

    async clear() {
      this.messages = [];
      this.toolLog = [];
      this.lastModified = [];
      this.harnessDigest = emptyDigest();
      if (this.projectId) {
        saveHarnessDigest(this.projectId, this.harnessDigest, this.sessionId);
      }
      this.error = '';
      await this.persist();
    },

    clearHarnessMemory() {
      this.harnessDigest = emptyDigest();
      if (this.projectId) {
        saveHarnessDigest(this.projectId, this.harnessDigest, this.sessionId);
      }
    },

    clearTurn() {
      this.toolLog = [];
      this.turnModifiedFiles = [];
      this.error = '';
    },

    pushUser(text: string) {
      this.messages.push({
        id: nextMessageId('u'),
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
      });
    },

    beginAssistant(): string {
      const id = nextMessageId('a');
      this.messages.push({
        id,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
      });
      return id;
    },

    updateAssistant(id: string, content: string, reasoning?: string) {
      const m = this.messages.find((x) => x.id === id);
      if (m) {
        m.content = content;
        if (reasoning) m.reasoning = reasoning;
      }
    },

    pushAssistant(text: string, reasoning?: string) {
      this.messages.push({
        id: nextMessageId('a'),
        role: 'assistant',
        content: text,
        reasoning,
        createdAt: new Date().toISOString(),
      });
    },

    applyResult(result: AgentTurnResult, assistantId?: string) {
      this.toolLog = result.toolLog;
      this.turnModifiedFiles = [...(result.modifiedFiles || [])];
      // 累计本轮修改到会话 lastModified，避免覆盖历史轮次
      const merged = new Set([...this.lastModified, ...result.modifiedFiles]);
      this.lastModified = [...merged];
      if (result.harnessDigest) {
        this.harnessDigest = result.harnessDigest;
        if (this.projectId) {
          saveHarnessDigest(this.projectId, this.harnessDigest, this.sessionId);
        }
      }
      if (assistantId) {
        this.updateAssistant(assistantId, result.content, result.reasoning);
      } else {
        this.pushAssistant(result.content, result.reasoning);
      }
    },

    removeTurnModified(paths: string[]) {
      if (!paths.length) return;
      const drop = new Set(paths);
      this.turnModifiedFiles = this.turnModifiedFiles.filter((f) => !drop.has(f));
      this.lastModified = this.lastModified.filter((f) => !drop.has(f));
    },

    setStreaming(v: boolean) {
      this.streaming = v;
    },

    setError(msg: string) {
      this.error = msg;
    },

    fillAssistantError(assistantId: string, msg: string) {
      const m = this.messages.find((x) => x.id === assistantId);
      if (m && !m.content.trim()) {
        m.content = `（失败）${msg}`;
      }
    },
  },
});
