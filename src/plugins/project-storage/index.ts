import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
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

/** 应用内默认数据根（不依赖 SAF，重装前一直可用） */
export const LOCAL_APP_DATA_URI = 'local://app-data';

export function isLocalTreeUri(treeUri: string): boolean {
  return /^local:\/\//i.test(String(treeUri || '').trim());
}

function localRootKey(treeUri: string): string {
  const raw = treeUri.replace(/^local:\/\//i, '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48);
  return raw || 'app-data';
}

function localFullPath(treeUri: string, rel: string): string {
  const base = `agent-app/data/${localRootKey(treeUri)}`;
  const n = rel.replace(/^\/+/, '').replace(/\\/g, '/');
  return n ? `${base}/${n}` : base;
}

async function ensureLocalParent(path: string): Promise<void> {
  const dir = path.split('/').slice(0, -1).join('/');
  if (!dir) return;
  try {
    await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true });
  } catch {
    /* exists */
  }
}

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

/** 持久化用户选择的 SAF 目录权限 */
export async function persistTreeUri(treeUri: string): Promise<{ ok: boolean; message?: string }> {
  if (!treeUri || isLocalTreeUri(treeUri)) {
    return { ok: true };
  }
  if (!Capacitor.isNativePlatform()) {
    return { ok: true, message: 'web noop' };
  }
  try {
    return await ProjectStorage.persistTreeUri({ treeUri });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function writeTreeText(treeUri: string, path: string, data: string): Promise<void> {
  if (isLocalTreeUri(treeUri)) {
    const full = localFullPath(treeUri, path);
    await ensureLocalParent(full);
    await Filesystem.writeFile({
      path: full,
      data,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return;
  }
  await ProjectStorage.writeTreeText({ treeUri, path, data });
}

export async function readTreeText(treeUri: string, path: string): Promise<string> {
  if (isLocalTreeUri(treeUri)) {
    try {
      const r = await Filesystem.readFile({
        path: localFullPath(treeUri, path),
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      return typeof r.data === 'string' ? r.data : '';
    } catch {
      throw new Error('文件不存在');
    }
  }
  const r = await ProjectStorage.readTreeText({ treeUri, path });
  return r.data ?? '';
}

export async function deleteTreePath(treeUri: string, path: string): Promise<void> {
  if (isLocalTreeUri(treeUri)) {
    const full = localFullPath(treeUri, path);
    try {
      const stat = await Filesystem.stat({ path: full, directory: Directory.Data });
      if (stat.type === 'directory') {
        await Filesystem.rmdir({ path: full, directory: Directory.Data, recursive: true });
      } else {
        await Filesystem.deleteFile({ path: full, directory: Directory.Data });
      }
    } catch {
      /* missing ok */
    }
    return;
  }
  await ProjectStorage.deleteTreePath({ treeUri, path });
}

export async function listTreeDir(treeUri: string, path = ''): Promise<string[]> {
  if (isLocalTreeUri(treeUri)) {
    try {
      const r = await Filesystem.readdir({
        path: localFullPath(treeUri, path || ''),
        directory: Directory.Data,
      });
      return (r.files || []).map((f) => (typeof f === 'string' ? f : f.name));
    } catch {
      return [];
    }
  }
  const r = await ProjectStorage.listTreeDir({ treeUri, path });
  return r.names || [];
}
