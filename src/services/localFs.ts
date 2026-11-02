import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import type { WorkProject } from '@/types';
import {
  listAllSandboxFiles,
  syncProjectToSandbox,
  exportFilesToPhone,
  persistTreeUri,
  pickAndPersistDirectory,
  verifyTreeAccess,
  writeTreeText,
  readTreeText,
  deleteTreePath,
  listTreeDir,
} from '@/plugins/project-storage';
import type { ExportFilesResult, SyncTreeResult } from '@/plugins/project-storage/definitions';

const APP_DATA = 'agent-app';

function normRel(path: string): string {
  return path.replace(/^\/+/, '').replace(/\\/g, '/');
}

function storagePath(projectId: string, rel: string): string {
  return `${APP_DATA}/projects/${projectId}/${normRel(rel)}`;
}

/** 是否绑定了可实时写入的手机/本地工作区（Cursor 式落盘目标） */
export function hasLiveWorkspace(project: WorkProject): boolean {
  return Boolean(project.localRootUri?.trim());
}

export interface WriteProjectResult {
  /** 已写入绑定的手机目录（或 local 工作区） */
  phoneSynced: boolean;
}

export async function pickProjectFolder(): Promise<{ uri: string; label: string }> {
  // 真机：走原生 SAF，申请可读可写可持久化权限
  if (Capacitor.isNativePlatform()) {
    const picked = await pickAndPersistDirectory();
    const uri = picked.uri?.trim();
    if (!uri) throw new Error('未选择目录');
    const access = await verifyTreeAccess(uri);
    if (!access.ok) {
      throw new Error('无法读取该文件夹，请重新选择并允许访问');
    }
    return { uri, label: picked.label || '项目目录' };
  }

  const result = await FilePicker.pickDirectory();
  const uri = result.path || '';
  if (!uri) {
    throw new Error('未选择目录');
  }
  await persistTreeUri(uri);
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

async function readSandboxFile(projectId: string, rel: string): Promise<string> {
  const r = await Filesystem.readFile({
    path: storagePath(projectId, rel),
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  });
  return typeof r.data === 'string' ? r.data : '';
}

async function writeSandboxFile(projectId: string, rel: string, content: string): Promise<void> {
  const full = storagePath(projectId, rel);
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

export async function readProjectFile(project: WorkProject, relPath: string): Promise<string> {
  const rel = normRel(relPath);
  // 沙盒缓存优先（Agent 刚写入后立刻可读）
  try {
    return await readSandboxFile(project.id, rel);
  } catch {
    /* try live workspace */
  }
  if (hasLiveWorkspace(project)) {
    try {
      return await readTreeText(project.localRootUri, rel);
    } catch {
      /* fall through */
    }
  }
  throw new Error(
    `无法读取 ${rel}。请确认文件在手机工作区中，或先在「项目 → 同步到 App」导入后再试。`,
  );
}

/**
 * 写入文件：对齐 Cursor —— 绑定手机目录时立即落到手机（自动建父目录），
 * 并镜像到沙盒供后续读/搜/FTP。一次对话可连续调用写入多个文件。
 */
export async function writeProjectFile(
  project: WorkProject,
  relPath: string,
  content: string,
): Promise<WriteProjectResult> {
  const rel = normRel(relPath);
  if (!rel || rel.includes('..')) {
    throw new Error('非法文件路径');
  }

  let phoneSynced = false;
  if (hasLiveWorkspace(project)) {
    try {
      // SAF writeTreeText 会递归创建父目录，支持 src/a/b/c.ts 这类深层路径
      await writeTreeText(project.localRootUri, rel, content);
      phoneSynced = true;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // 手机写失败时仍尝试写沙盒，并记入待写回队列，避免整轮白做
      try {
        await writeSandboxFile(project.id, rel, content);
        await trackModified(project.id, rel);
      } catch {
        /* ignore secondary */
      }
      throw new Error(`写入手机失败（${rel}）：${reason}`);
    }
  }

  try {
    await writeSandboxFile(project.id, rel, content);
  } catch (e) {
    if (phoneSynced) {
      // 手机已落盘，沙盒镜像失败不阻断（下次同步可补）
      return { phoneSynced: true };
    }
    throw e instanceof Error ? e : new Error(String(e));
  }

  return { phoneSynced };
}

export async function deleteProjectFile(project: WorkProject, relPath: string): Promise<void> {
  const rel = normRel(relPath);
  let phoneErr: string | null = null;
  if (hasLiveWorkspace(project)) {
    try {
      await deleteTreePath(project.localRootUri, rel);
    } catch (e) {
      phoneErr = e instanceof Error ? e.message : String(e);
    }
  }
  try {
    await Filesystem.deleteFile({
      path: storagePath(project.id, rel),
      directory: Directory.Data,
    });
  } catch {
    /* sandbox missing ok if phone deleted */
  }
  if (phoneErr && hasLiveWorkspace(project)) {
    throw new Error(`删除手机文件失败（${rel}）：${phoneErr}`);
  }
}

/** 递归删除目录（沙盒 + 手机工作区） */
export async function deleteProjectDir(project: WorkProject, relPath: string): Promise<void> {
  const rel = normRel(relPath);
  if (!rel || rel.includes('..')) throw new Error('非法目录路径');
  let phoneErr: string | null = null;
  if (hasLiveWorkspace(project)) {
    try {
      await deleteTreePath(project.localRootUri, rel);
    } catch (e) {
      phoneErr = e instanceof Error ? e.message : String(e);
    }
  }
  try {
    await Filesystem.rmdir({
      path: storagePath(project.id, rel),
      directory: Directory.Data,
      recursive: true,
    });
  } catch {
    /* sandbox missing ok */
  }
  if (phoneErr) {
    throw new Error(`删除手机目录失败（${rel}）：${phoneErr}`);
  }
}

/**
 * 创建目录（递归）。手机侧通过占位文件确保父链存在后删除占位，
 * 避免 SAF 无独立 mkdir API 时建不出空目录。
 */
export async function createLocalDir(project: WorkProject, relPath: string): Promise<void> {
  const rel = normRel(relPath);
  if (!rel || rel.includes('..')) throw new Error('目录名不能为空');
  await Filesystem.mkdir({
    path: storagePath(project.id, rel),
    directory: Directory.Data,
    recursive: true,
  });
  if (!hasLiveWorkspace(project)) return;

  const keep = `${rel}/.agentkeep`;
  try {
    await writeTreeText(project.localRootUri, keep, '');
    try {
      await deleteTreePath(project.localRootUri, keep);
    } catch {
      /* keep 可留，不影响使用 */
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`创建手机目录失败（${rel}）：${reason}`);
  }
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
  const rel = normRel(relPath);
  // 绑定手机工作区时以手机为准（与 Cursor 工作区一致），再合并沙盒未见项
  const names = new Set<string>();
  if (hasLiveWorkspace(project)) {
    try {
      for (const n of await listTreeDir(project.localRootUri, rel)) {
        if (n && n !== '.agentkeep') names.add(n);
      }
    } catch {
      /* fall through sandbox */
    }
  }

  const base = storagePath(project.id, rel);
  try {
    const r = await Filesystem.readdir({ path: base, directory: Directory.Data });
    for (const f of r.files || []) {
      const name = typeof f === 'string' ? f : f.name;
      if (name && !name.startsWith('.') && name !== '.agentkeep') names.add(name);
    }
  } catch {
    if (!names.size) {
      const all = await listAllSandboxFiles(project.id);
      const prefix = rel;
      for (const f of all) {
        if (prefix && !(f === prefix || f.startsWith(prefix + '/'))) continue;
        const rest = prefix ? f.slice(prefix.length).replace(/^\//, '') : f;
        const top = rest.split('/')[0];
        if (top) names.add(top);
      }
    }
  }
  return [...names];
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
