import { defineStore } from 'pinia';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type { AgentServerConfig } from '@/types';
import type { ChatStorageRoot } from '@/services/chatSessionFs';
import {
  LOCAL_APP_DATA_URI,
  isLocalTreeUri,
  persistTreeUri,
  pickAndPersistDirectory,
  verifyTreeAccess,
} from '@/plugins/project-storage';
import {
  loadSettingsFromDataRoot,
  saveSettingsToDataRoot,
} from '@/services/appDataFs';

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
    apiKey: '',
    model: '',
    maxTokens: 8192,
    temperature: 0.7,
    toolsEnabled: true,
  };
}

function webPreviewRoot(): ChatStorageRoot {
  return {
    uri: LOCAL_APP_DATA_URI,
    label: '本机预览数据目录',
  };
}

function labelFromUri(uri: string, fallback = '应用数据目录'): string {
  const parts = uri.split('/');
  return decodeURIComponent(parts[parts.length - 1] || fallback);
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
    storageAccessOk: false,
    loaded: false,
  }),

  getters: {
    isConfigured(state): boolean {
      return Boolean(state.config.apiBaseUrl?.trim() && state.config.apiKey?.trim());
    },
    hasChatStorageRoot(state): boolean {
      const uri = state.chatStorageRoot?.uri?.trim() || '';
      if (!uri) return false;
      // 真机不接受内部 local://，必须选手机目录
      if (Capacitor.isNativePlatform() && isLocalTreeUri(uri)) return false;
      return true;
    },
    isExternalDataRoot(state): boolean {
      const uri = state.chatStorageRoot?.uri || '';
      return Boolean(uri) && !isLocalTreeUri(uri);
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

      // 真机：丢弃内部存储，强制用户授权手机目录
      if (Capacitor.isNativePlatform()) {
        if (!this.chatStorageRoot?.uri || isLocalTreeUri(this.chatStorageRoot.uri)) {
          this.chatStorageRoot = null;
          this.storageAccessOk = false;
          await this.persistChatStorageRoot();
        } else {
          await this.refreshStorageAccess();
        }
      } else {
        // Web 预览才用内部目录
        if (!this.chatStorageRoot?.uri) {
          this.chatStorageRoot = webPreviewRoot();
          await this.persistChatStorageRoot();
        }
        this.storageAccessOk = true;
      }

      const prefsEmpty = !raw.value;
      if (prefsEmpty && this.hasChatStorageRoot && this.chatStorageRoot) {
        const fromDisk = await loadSettingsFromDataRoot(this.chatStorageRoot);
        if (fromDisk?.config) {
          this.config = migrateLegacyConfig(fromDisk.config as unknown as Record<string, unknown>);
          if (Array.isArray(fromDisk.models)) this.models = fromDisk.models;
          await this.persist();
        }
      } else if (this.hasChatStorageRoot) {
        void this.syncToDataRoot();
      }

      this.loaded = true;
    },

    async refreshStorageAccess(): Promise<boolean> {
      if (!this.chatStorageRoot?.uri || isLocalTreeUri(this.chatStorageRoot.uri)) {
        this.storageAccessOk = !Capacitor.isNativePlatform();
        return this.storageAccessOk;
      }
      try {
        await persistTreeUri(this.chatStorageRoot.uri);
        const v = await verifyTreeAccess(this.chatStorageRoot.uri);
        this.storageAccessOk = Boolean(v.ok);
        return this.storageAccessOk;
      } catch {
        this.storageAccessOk = false;
        return false;
      }
    },

    async persist() {
      await Preferences.set({
        key: STORAGE_KEY,
        value: JSON.stringify({
          ...this.config,
          models: this.models,
        }),
      });
      await this.syncToDataRoot();
    },

    async syncToDataRoot() {
      if (!this.hasChatStorageRoot || !this.chatStorageRoot?.uri) return;
      try {
        await saveSettingsToDataRoot(this.chatStorageRoot, {
          config: { ...this.config },
          models: [...this.models],
        });
      } catch {
        /* SAF 失效时不影响 Preferences */
      }
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

    /** 选择手机目录并申请读/写/列表持久权限 */
    async pickChatStorageRoot(): Promise<ChatStorageRoot> {
      if (!Capacitor.isNativePlatform()) {
        const root = webPreviewRoot();
        this.chatStorageRoot = root;
        this.storageAccessOk = true;
        await this.persistChatStorageRoot();
        await this.syncToDataRoot();
        return root;
      }

      const picked = await pickAndPersistDirectory();
      const uri = picked.uri?.trim();
      if (!uri) throw new Error('未选择目录');
      if (isLocalTreeUri(uri)) throw new Error('请选择手机上的真实文件夹');

      const root: ChatStorageRoot = {
        uri,
        label: picked.label || labelFromUri(uri),
      };
      this.chatStorageRoot = root;
      await this.persistChatStorageRoot();

      const ok = await this.refreshStorageAccess();
      if (!ok) {
        throw new Error('目录授权失败：无法读取该文件夹，请重新选择并允许访问');
      }
      await this.syncToDataRoot();
      return root;
    },

    async clearChatStorageRoot() {
      this.chatStorageRoot = null;
      this.storageAccessOk = false;
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
