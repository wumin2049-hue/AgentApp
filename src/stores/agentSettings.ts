import { defineStore } from 'pinia';
import { Preferences } from '@capacitor/preferences';
import type { AgentServerConfig } from '@/types';

const STORAGE_KEY = 'mincode_agent_settings';

export interface AgentModelRow {
  id: number;
  model_key: string;
  name?: string;
  is_enabled?: number;
}

function defaultConfig(): AgentServerConfig {
  return {
    apiBaseUrl: '',
    apiKey: '',
    model: '',
    maxTokens: 8192,
    temperature: 0.7,
    toolsEnabled: true,
  };
}

function migrateLegacyConfig(raw: Record<string, unknown>): AgentServerConfig {
  const cfg = defaultConfig();
  if (typeof raw.apiBaseUrl === 'string' && raw.apiBaseUrl.trim()) {
    cfg.apiBaseUrl = raw.apiBaseUrl.trim();
  }
  if (typeof raw.apiKey === 'string') {
    cfg.apiKey = raw.apiKey;
  }
  if (typeof raw.model === 'string') cfg.model = raw.model;
  if (typeof raw.systemPrompt === 'string') cfg.systemPrompt = raw.systemPrompt;
  if (typeof raw.maxTokens === 'number') cfg.maxTokens = raw.maxTokens;
  if (typeof raw.temperature === 'number') cfg.temperature = raw.temperature;
  if (typeof raw.toolsEnabled === 'boolean') cfg.toolsEnabled = raw.toolsEnabled;

  // 旧版 agent 站点配置（baseUrl）无法自动转为上游 Key，仅保留 model
  if (!cfg.apiBaseUrl && typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) {
    if (!cfg.model && typeof raw.model === 'string') cfg.model = raw.model;
  }
  return cfg;
}

export const useAgentSettingsStore = defineStore('agentSettings', {
  state: () => ({
    config: defaultConfig() as AgentServerConfig,
    models: [] as AgentModelRow[],
    loaded: false,
  }),

  getters: {
    isConfigured(state): boolean {
      return Boolean(state.config.apiBaseUrl?.trim() && state.config.apiKey?.trim());
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

    async update(patch: Partial<AgentServerConfig>) {
      this.config = { ...this.config, ...patch };
      await this.persist();
    },

    async setModels(models: AgentModelRow[]) {
      this.models = models;
      await this.persist();
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
