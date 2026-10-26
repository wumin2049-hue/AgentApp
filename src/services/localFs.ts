import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import type { WorkProject } from '@/types';
import {
  listAllSandboxFiles,
  syncProjectToSandbox,
  exportFilesToPhone,
} from '@/plugins/project-storage';
import type { ExportFilesResult, SyncTreeResult } from '@/plugins/project-storage/definitions';

const APP_DATA = 'agent-app';

function normRel(path: string): string {
  return path.replace(/^\/+/, '').replace(/\\/g, '/');
}

function storagePath(projectId: string, rel: string): string {
  return `${APP_DATA}/projects/${projectId}/${normRel(rel)}`;
}

export async function pickProjectFolder(): Promise<{ uri: string; label: string }> {
  const result = await FilePicker.pickDirectory();
  const uri = result.path || '';
  if (!uri) {
    throw new Error('未选择目录');
  }
  const parts = uri.split('/');
  const label = decodeURIComponent(parts[parts.length - 1] || '项目目录');
  return { uri, label };
}

export async function importExternalTree(projectId: string, externalUri: string): Promise<void> {
  await Filesystem.writeFile({
    path: `${APP_DATA}/projects/${projectId}/.source_uri`,
    data: externalUri,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  });
}

/** 从手机目录同步到 App 沙盒（需 Android 原生插件） */
export async function syncProjectFiles(project: WorkProject): Promise<SyncTreeResult> {
  if (!project.localRootUri) {
    throw new Error('未绑定本地目录');
  }
  const result = await syncProjectToSandbox(project.localRootUri, project.id);
  await importExternalTree(project.id, project.localRootUri);
  return result;
}

export async function readProjectFile(project: WorkProject, relPath: string): Promise<string> {
  const rel = normRel(relPath);
  try {
    const r = await Filesystem.readFile({
      path: storagePath(project.id, rel),
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return typeof r.data === 'string' ? r.data : '';
  } catch {
    throw new Error(
      `无法读取 ${rel}。请在「项目 → 同步到 App」把手机目录导入沙盒后再试。`,
    );
  }
}

export async function writeProjectFile(
  project: WorkProject,
  relPath: string,
  content: string,
): Promise<void> {
  const rel = normRel(relPath);
  const full = storagePath(project.id, rel);
  const dir = full.split('/').slice(0, -1).join('/');
  if (dir) {
    try {
      await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true });
    } catch {
      /* exists */
    }
  }
  await Filesystem.writeFile({
    path: full,
    data: content,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  });
}

export async function deleteProjectFile(project: WorkProject, relPath: string): Promise<void> {
  await Filesystem.deleteFile({
    path: storagePath(project.id, normRel(relPath)),
    directory: Directory.Data,
  });
}

/** 递归删除沙盒内目录 */
export async function deleteProjectDir(project: WorkProject, relPath: string): Promise<void> {
  const rel = normRel(relPath);
  if (!rel || rel.includes('..')) throw new Error('非法目录路径');
  await Filesystem.rmdir({
    path: storagePath(project.id, rel),
    directory: Directory.Data,
    recursive: true,
  });
}

export async function createLocalDir(project: WorkProject, relPath: string): Promise<void> {
  const rel = normRel(relPath);
  if (!rel) throw new Error('目录名不能为空');
  await Filesystem.mkdir({
    path: storagePath(project.id, rel),
    directory: Directory.Data,
    recursive: true,
  });
}

/** 列出某目录下所有文件（递归，不含目录本身） */
export async function listLocalFilesRecursive(
  project: WorkProject,
  basePath = '',
): Promise<string[]> {
  const prefix = normRel(basePath);
  const all = await listAllSandboxFiles(project.id);
  return all.filter((f) => {
    if (f.startsWith('.')) return false;
    if (!prefix) return true;
    return f === prefix || f.startsWith(prefix + '/');
  });
}

export interface LocalEntry {
  name: string;
  relPath: string;
  isDirectory: boolean;
  size?: number;
}

const SKIP_LOCAL_NAMES = new Set(['.source_uri', '.modified.json']);

export async function listLocalEntries(
  project: WorkProject,
  relPath = '',
): Promise<LocalEntry[]> {
  const base = normRel(relPath);
  const names = await listProjectDir(project, base);
  const entries: LocalEntry[] = [];

  for (const name of names) {
    if (name.startsWith('.') || SKIP_LOCAL_NAMES.has(name)) continue;
    const childRel = base ? `${base}/${name}` : name;
    try {
      const stat = await Filesystem.stat({
        path: storagePath(project.id, childRel),
        directory: Directory.Data,
      });
      entries.push({
        name,
        relPath: childRel,
        isDirectory: stat.type === 'directory',
        size: stat.size,
      });
    } catch {
      const all = await listAllSandboxFiles(project.id);
      const isDir = all.some((f) => f.startsWith(childRel + '/'));
      entries.push({ name, relPath: childRel, isDirectory: isDir });
    }
  }

  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function listProjectDir(project: WorkProject, relPath = ''): Promise<string[]> {
  const base = storagePath(project.id, normRel(relPath));
  try {
    const r = await Filesystem.readdir({ path: base, directory: Directory.Data });
    return (r.files || []).map((f) => (typeof f === 'string' ? f : f.name));
  } catch {
    if (!relPath) {
      const all = await listAllSandboxFiles(project.id);
      if (all.length) {
        const prefix = normRel(relPath);
        const set = new Set<string>();
        for (const f of all) {
          const parts = f.split('/');
          const top = parts[prefix ? prefix.split('/').length : 0];
          if (top) set.add(top);
        }
        return [...set];
      }
    }
    return [];
  }
}

export async function grepProject(
  project: WorkProject,
  pattern: string,
  subPath = '',
): Promise<string> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'gi');
  } catch {
    return '无效的正则: ' + pattern;
  }

  const lines: string[] = [];
  const all = await listAllSandboxFiles(project.id);
  const prefix = normRel(subPath);
  const candidates = all.filter((f) => !prefix || f.startsWith(prefix + '/') || f === prefix);

  for (const rel of candidates.slice(0, 300)) {
    try {
      const text = await readProjectFile(project, rel);
      text.split('\n').forEach((line, i) => {
        re.lastIndex = 0;
        if (re.test(line)) {
          lines.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    } catch {
      /* skip binary / missing */
    }
    if (lines.length >= 200) break;
  }
  return lines.slice(0, 200).join('\n') || '（无匹配）';
}

export async function globProject(project: WorkProject, pattern: string): Promise<string> {
  const all = await listAllSandboxFiles(project.id);
  const glob = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
  let re: RegExp;
  try {
    re = new RegExp(glob, 'i');
  } catch {
    return '无效 glob: ' + pattern;
  }
  return all.filter((f) => re.test(f)).slice(0, 200).join('\n') || '（无匹配）';
}

export async function trackModified(projectId: string, relPath: string): Promise<void> {
  const key = `${APP_DATA}/projects/${projectId}/.modified.json`;
  let list: string[] = [];
  try {
    const r = await Filesystem.readFile({ path: key, directory: Directory.Data, encoding: Encoding.UTF8 });
    list = JSON.parse(typeof r.data === 'string' ? r.data : '[]') as string[];
  } catch {
    list = [];
  }
  const rel = normRel(relPath);
  if (!list.includes(rel)) {
    list.push(rel);
  }
  await Filesystem.writeFile({
    path: key,
    data: JSON.stringify(list),
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  });
}

export async function getModifiedFiles(projectId: string): Promise<string[]> {
  try {
    const r = await Filesystem.readFile({
      path: `${APP_DATA}/projects/${projectId}/.modified.json`,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return JSON.parse(typeof r.data === 'string' ? r.data : '[]') as string[];
  } catch {
    return [];
  }
}

export async function clearModifiedFiles(projectId: string): Promise<void> {
  try {
    await Filesystem.deleteFile({
      path: `${APP_DATA}/projects/${projectId}/.modified.json`,
      directory: Directory.Data,
    });
  } catch {
    /* noop */
  }
}

/** 从修改列表中移除已成功处理的路径，保留失败项 */
export async function removeModifiedFiles(projectId: string, done: string[]): Promise<void> {
  if (!done.length) return;
  const remaining = (await getModifiedFiles(projectId)).filter((p) => !done.includes(p));
  const key = `${APP_DATA}/projects/${projectId}/.modified.json`;
  if (!remaining.length) {
    await clearModifiedFiles(projectId);
    return;
  }
  await Filesystem.writeFile({
    path: key,
    data: JSON.stringify(remaining),
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  });
}

/** 删除项目沙盒目录（配置删除时可选清理） */
export async function deleteProjectSandbox(projectId: string): Promise<void> {
  try {
    await Filesystem.rmdir({
      path: `${APP_DATA}/projects/${projectId}`,
      directory: Directory.Data,
      recursive: true,
    });
  } catch {
    /* noop */
  }
}

export async function countSandboxFiles(projectId: string): Promise<number> {
  const files = await listAllSandboxFiles(projectId);
  return files.length;
}

/** 将沙盒内修改写回用户选择的手机目录（需 Android 原生插件） */
export async function exportModifiedToPhone(
  project: WorkProject,
  paths: string[],
): Promise<ExportFilesResult> {
  if (!project.localRootUri) {
    throw new Error('未绑定本地目录');
  }
  if (!paths.length) {
    return { exported: 0, errors: [] };
  }
  return exportFilesToPhone(project.localRootUri, project.id, paths);
}
