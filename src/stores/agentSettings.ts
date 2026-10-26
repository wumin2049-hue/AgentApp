import { defineStore } from 'pinia';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import type { AgentServerConfig } from '@/types';
import type { ChatStorageRoot } from '@/services/chatSessionFs';

const STORAGE_KEY = 'mincode_agent_settings';
const CHAT_ROOT_KEY = 'abs_chat_storage_root';

export interface AgentModelRow {
  id: number;
  model_key: string;
  name?: string;
  is_enabled?: number;
}

function defaultConfig(): AgentServerConfig {
  return {
    apiBaseUrl: 'https://ai.1k0.com/v1',
    apiKey: 'sk-ar-5ad8692d1cfc051618b194057511756e5f55ee66fe0d6beb0bf5b879a0dc6509',
    model: 'deepseek-4.1-flash',
    maxTokens: 8192,
    temperature: 0.7,
    toolsEnabled: true,
  };
}

function labelFromUri(uri: string): string {
  const parts = uri.split('/');
  return decodeURIComponent(parts[parts.length - 1] || '会话目录');
}

function migrateLegacyConfig(raw: Record<string, unknown>): AgentServerConfig {
  const cfg = defaultConfig();
  if (typeof raw.apiBaseUrl === 'string' && raw.apiBaseUrl.trim()) {
    cfg.apiBaseUrl = raw.apiBaseUrl.trim();
  }
  if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) {
    cfg.apiKey = raw.apiKey;
  }
  if (typeof raw.model === 'string' && raw.model.trim()) {
    cfg.model = raw.model.trim();
  }
  if (typeof raw.systemPrompt === 'string') cfg.systemPrompt = raw.systemPrompt;
  if (typeof raw.maxTokens === 'number') cfg.maxTokens = raw.maxTokens;
  if (typeof raw.temperature === 'number') cfg.temperature = raw.temperature;
  if (typeof raw.toolsEnabled === 'boolean') cfg.toolsEnabled = raw.toolsEnabled;
  return cfg;
}

export const useAgentSettingsStore = defineStore('agentSettings', {
  state: () => ({
    config: defaultConfig() as AgentServerConfig,
    models: [] as AgentModelRow[],
    chatStorageRoot: null as ChatStorageRoot | null,
    loaded: false,
  }),

  getters: {
    isConfigured(state): boolean {
      return Boolean(state.config.apiBaseUrl?.trim() && state.config.apiKey?.trim());
    },
    hasChatStorageRoot(state): boolean {
      return Boolean(state.chatStorageRoot?.uri?.trim());
    },
    agentConfig(state): AgentServerConfig {
      return { ...state.config };
    },
    apiKeyMask(state): string {
      const k = state.config.apiKey || '';
      if (!k) return '';
      if (k.length <= 8) return '••••';
      return `${k.slice(0, 4)}…${k.slice(-4)}`;
    },
  },

  actions: {
    async load() {
      const raw = await Preferences.get({ key: STORAGE_KEY });
      if (raw.value) {
        try {
          const data = JSON.parse(raw.value) as Record<string, unknown> & { models?: AgentModelRow[] };
          this.config = migrateLegacyConfig(data);
          if (Array.isArray(data.models)) {
            this.models = data.models;
          }
        } catch {
          this.config = defaultConfig();
        }
      }
      const rootRaw = await Preferences.get({ key: CHAT_ROOT_KEY });
      if (rootRaw.value) {
        try {
          const root = JSON.parse(rootRaw.value) as ChatStorageRoot;
          if (root?.uri) this.chatStorageRoot = root;
        } catch {
          this.chatStorageRoot = null;
        }
      }
      this.loaded = true;
    },

    async persist() {
      await Preferences.set({
        key: STORAGE_KEY,
        value: JSON.stringify({
          ...this.config,
          models: this.models,
        }),
      });
    },

    async persistChatStorageRoot() {
      if (!this.chatStorageRoot) {
        await Preferences.remove({ key: CHAT_ROOT_KEY });
        return;
      }
      await Preferences.set({
        key: CHAT_ROOT_KEY,
        value: JSON.stringify(this.chatStorageRoot),
      });
    },

    async update(patch: Partial<AgentServerConfig>) {
      this.config = { ...this.config, ...patch };
      await this.persist();
    },

    async setModels(models: AgentModelRow[]) {
      this.models = models;
      await this.persist();
    },

    async pickChatStorageRoot(): Promise<ChatStorageRoot> {
      try {
        const result = await FilePicker.pickDirectory();
        const uri = result.path || '';
        if (!uri) throw new Error('未选择目录');
        const root: ChatStorageRoot = { uri, label: labelFromUri(uri) };
        this.chatStorageRoot = root;
        await this.persistChatStorageRoot();
        return root;
      } catch (e) {
        if (!Capacitor.isNativePlatform()) {
          const root: ChatStorageRoot = {
            uri: 'local://chat-sessions',
            label: '本机预览会话目录',
          };
          this.chatStorageRoot = root;
          await this.persistChatStorageRoot();
          return root;
        }
        throw e instanceof Error ? e : new Error(String(e));
      }
    },

    async clearChatStorageRoot() {
      this.chatStorageRoot = null;
      await this.persistChatStorageRoot();
    },

    async migrateFromProjectAgent(agent?: AgentServerConfig) {
      if (!agent) return;
      if (this.isConfigured) return;
      if (agent.apiBaseUrl?.trim() && agent.apiKey?.trim()) {
        this.config = { ...this.config, ...agent };
        await this.persist();
      }
    },
  },
});
