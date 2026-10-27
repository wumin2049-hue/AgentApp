import type { AgentServerConfig, WorkProject } from '@/types';
import type { ChatStorageRoot } from '@/services/chatSessionFs';
import { writeTreeText, readTreeText } from '@/plugins/project-storage';
import type { FtpBrowserState } from '@/services/ftpState';

const SETTINGS_FILE = 'app/settings.json';
const PROJECTS_FILE = 'app/projects.json';
const FTP_STATE_FILE = 'app/ftp-state.json';

export interface PersistedModelRow {
  id: number;
  model_key: string;
  name?: string;
  is_enabled?: number;
}

export interface PersistedSettingsPayload {
  config: AgentServerConfig;
  models: PersistedModelRow[];
}

export interface PersistedProjectsPayload {
  projects: WorkProject[];
  activeId: string;
}

async function readJsonFile<T>(root: ChatStorageRoot, path: string): Promise<T | null> {
  try {
    const raw = await readTreeText(root.uri, path);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(root: ChatStorageRoot, path: string, data: unknown): Promise<void> {
  await writeTreeText(root.uri, path, JSON.stringify(data, null, 2));
}

export async function saveSettingsToDataRoot(
  root: ChatStorageRoot,
  payload: PersistedSettingsPayload,
): Promise<void> {
  await writeJsonFile(root, SETTINGS_FILE, payload);
}

export async function loadSettingsFromDataRoot(
  root: ChatStorageRoot,
): Promise<PersistedSettingsPayload | null> {
  return readJsonFile<PersistedSettingsPayload>(root, SETTINGS_FILE);
}

export async function saveProjectsToDataRoot(
  root: ChatStorageRoot,
  payload: PersistedProjectsPayload,
): Promise<void> {
  await writeJsonFile(root, PROJECTS_FILE, payload);
}

export async function loadProjectsFromDataRoot(
  root: ChatStorageRoot,
): Promise<PersistedProjectsPayload | null> {
  return readJsonFile<PersistedProjectsPayload>(root, PROJECTS_FILE);
}

export async function saveFtpStateToDataRoot(
  root: ChatStorageRoot,
  map: Record<string, FtpBrowserState>,
): Promise<void> {
  await writeJsonFile(root, FTP_STATE_FILE, map);
}

export async function loadFtpStateFromDataRoot(
  root: ChatStorageRoot,
): Promise<Record<string, FtpBrowserState> | null> {
  return readJsonFile<Record<string, FtpBrowserState>>(root, FTP_STATE_FILE);
}
