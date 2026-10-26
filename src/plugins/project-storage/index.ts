import { registerPlugin } from '@capacitor/core';
import type {
  AgentProjectStoragePlugin,
  ExportFilesResult,
  SyncTreeResult,
} from './definitions';

export const ProjectStorage = registerPlugin<AgentProjectStoragePlugin>('AgentProjectStorage', {
  web: () => import('./web').then((m) => new m.AgentProjectStorageWeb()),
});

const TEXT_EXT = new Set([
  '.php', '.js', '.ts', '.vue', '.css', '.html', '.json', '.md', '.txt',
  '.xml', '.yml', '.yaml', '.env', '.htaccess', '.sql', '.sh', '.bat',
  '.jsx', '.tsx', '.scss', '.less', '.svg', '.ini', '.conf',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', '.gradle',
  'android', 'ios', '.idea', 'logs', 'runtime', 'storage',
]);

export function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (SKIP_DIRS.has(lower)) return false;
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return false;
  return TEXT_EXT.has(lower.slice(dot));
}

export async function syncProjectToSandbox(
  treeUri: string,
  projectId: string,
): Promise<SyncTreeResult> {
  return ProjectStorage.syncTree({
    treeUri,
    projectId,
    maxFiles: 800,
    maxFileBytes: 512 * 1024,
  });
}

export async function listAllSandboxFiles(projectId: string): Promise<string[]> {
  const r = await ProjectStorage.listSandbox({ projectId });
  return r.files || [];
}

export async function exportFilesToPhone(
  treeUri: string,
  projectId: string,
  paths: string[],
): Promise<ExportFilesResult> {
  return ProjectStorage.exportFiles({ treeUri, projectId, paths });
}

export async function writeTreeText(treeUri: string, path: string, data: string): Promise<void> {
  await ProjectStorage.writeTreeText({ treeUri, path, data });
}

export async function readTreeText(treeUri: string, path: string): Promise<string> {
  const r = await ProjectStorage.readTreeText({ treeUri, path });
  return r.data ?? '';
}

export async function deleteTreePath(treeUri: string, path: string): Promise<void> {
  await ProjectStorage.deleteTreePath({ treeUri, path });
}

export async function listTreeDir(treeUri: string, path = ''): Promise<string[]> {
  const r = await ProjectStorage.listTreeDir({ treeUri, path });
  return r.names || [];
}
