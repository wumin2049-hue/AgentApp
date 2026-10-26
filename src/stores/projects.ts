import { defineStore } from 'pinia';
import { Preferences } from '@capacitor/preferences';
import type { WorkProject, FtpConfig } from '@/types';
import { useAgentSettingsStore } from './agentSettings';
import { pickProjectFolder, syncProjectFiles } from '@/services/localFs';

const STORAGE_KEY = 'abs_work_projects';
const ACTIVE_KEY = 'abs_active_project_id';

function newId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultFtp(): FtpConfig {
  return {
    host: '',
    port: 21,
    username: '',
    password: '',
    remoteRoot: '/',
    passive: true,
    secure: false,
  };
}

export const useProjectsStore = defineStore('projects', {
  state: () => ({
    projects: [] as WorkProject[],
    activeId: '' as string,
    loaded: false,
  }),

  getters: {
    active(state): WorkProject | null {
      return state.projects.find((p) => p.id === state.activeId) || null;
    },
  },

  actions: {
    async load() {
      const raw = await Preferences.get({ key: STORAGE_KEY });
      const active = await Preferences.get({ key: ACTIVE_KEY });
      let projects = raw.value ? (JSON.parse(raw.value) as WorkProject[]) : [];
      const agentStore = useAgentSettingsStore();
      if (!agentStore.loaded) await agentStore.load();
      for (const p of projects) {
        if (p.agent?.apiBaseUrl || (p.agent as { baseUrl?: string })?.baseUrl) {
          await agentStore.migrateFromProjectAgent(p.agent);
        }
      }
      projects = projects.map((p) => {
        const { agent: _removed, ...rest } = p;
        return rest as WorkProject;
      });
      this.projects = projects;
      this.activeId = active.value || (this.projects[0]?.id ?? '');
      this.loaded = true;
      await this.persist();
    },

    async persist() {
      await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(this.projects) });
      await Preferences.set({ key: ACTIVE_KEY, value: this.activeId });
    },

    async createProject(name: string) {
      const picked = await pickProjectFolder();
      const now = new Date().toISOString();
      const project: WorkProject = {
        id: newId(),
        name: name || picked.label,
        createdAt: now,
        updatedAt: now,
        localRootUri: picked.uri,
        localRootLabel: picked.label,
        ftp: defaultFtp(),
      };
      this.projects.unshift(project);
      await syncProjectFiles(project);
      this.activeId = project.id;
      await this.persist();
      return project;
    },

    async updateProject(id: string, patch: Partial<WorkProject>) {
      const i = this.projects.findIndex((p) => p.id === id);
      if (i < 0) return;
      this.projects[i] = {
        ...this.projects[i],
        ...patch,
        updatedAt: new Date().toISOString(),
        ftp: { ...this.projects[i].ftp, ...(patch.ftp || {}) },
      };
      await this.persist();
    },

    async removeProject(id: string) {
      this.projects = this.projects.filter((p) => p.id !== id);
      if (this.activeId === id) {
        this.activeId = this.projects[0]?.id ?? '';
      }
      await this.persist();
    },

    setActive(id: string) {
      this.activeId = id;
      return Preferences.set({ key: ACTIVE_KEY, value: id });
    },
  },
});
