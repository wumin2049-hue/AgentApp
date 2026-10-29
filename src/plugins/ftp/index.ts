import { registerPlugin } from '@capacitor/core';
import type { AgentFtpPlugin, FtpListOptions } from './definitions';
import type { FtpConfig, FtpEntry, WorkProject } from '@/types';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

const NativeFtp = registerPlugin<AgentFtpPlugin>('AgentFtp', {
  web: () => import('./web').then((m) => new m.AgentFtpWeb()),
});

function resolveRemotePath(ftp: FtpConfig, path: string): string {
  const p = path.replace(/\\/g, '/');
  if (p.startsWith('/')) return p;
  const root = ftp.remoteRoot.replace(/\/+$/, '');
  return `${root}/${p.replace(/^\/+/, '')}`;
}

function cfgToOpts(ftp: FtpConfig, remotePath: string): FtpListOptions {
  return {
    host: ftp.host,
    port: ftp.port,
    username: ftp.username,
    password: ftp.password,
    remotePath,
    passive: ftp.passive,
    secure: ftp.secure,
  };
}

export async function ftpList(ftp: FtpConfig, remotePath: string): Promise<FtpEntry[]> {
  const r = await NativeFtp.list(cfgToOpts(ftp, remotePath));
  return (r.entries || []).map((e) => ({
    name: e.name,
    path: e.path,
    isDirectory: e.isDirectory,
    size: e.size,
  }));
}

export async function ftpUploadFile(
  ftp: FtpConfig,
  localSandboxPath: string,
  remoteRel: string,
): Promise<void> {
  const remote = resolveRemotePath(ftp, remoteRel);
  await NativeFtp.upload({
    ...cfgToOpts(ftp, ftp.remoteRoot),
    localPath: localSandboxPath,
    remotePath: remote,
  });
}

export async function ftpDownloadFile(
  ftp: FtpConfig,
  remoteFullPath: string,
  localSandboxPath: string,
): Promise<void> {
  await NativeFtp.download({
    ...cfgToOpts(ftp, ftp.remoteRoot),
    remotePath: remoteFullPath,
    localPath: localSandboxPath,
  });
}

export async function ftpDeleteRemote(ftp: FtpConfig, remoteFullPath: string): Promise<void> {
  await NativeFtp.delete({
    ...cfgToOpts(ftp, ftp.remoteRoot),
    remotePath: remoteFullPath,
    targetPath: remoteFullPath,
  });
}

/** 递归列出远程文件（不含目录项本身），有上限防止爆量 */
export async function ftpListFilesRecursive(
  ftp: FtpConfig,
  remoteDir: string,
  maxFiles = 300,
): Promise<FtpEntry[]> {
  const out: FtpEntry[] = [];
  const queue = [remoteDir.replace(/\/+$/, '') || '/'];

  while (queue.length && out.length < maxFiles) {
    const dir = queue.shift()!;
    const entries = await ftpList(ftp, dir);
    for (const e of entries) {
      if (e.name === '.' || e.name === '..') continue;
      if (e.isDirectory) {
        queue.push(e.path);
      } else {
        out.push(e);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

/** 递归删除：先删内部文件/子目录，再删当前目录 */
export async function ftpDeleteRecursive(
  ftp: FtpConfig,
  remotePath: string,
  isDirectory: boolean,
): Promise<{ deleted: number; errors: string[] }> {
  const errors: string[] = [];
  let deleted = 0;

  if (!isDirectory) {
    try {
      await ftpDeleteRemote(ftp, remotePath);
      deleted++;
    } catch (e) {
      errors.push(`${remotePath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { deleted, errors };
  }

  try {
    const children = await ftpList(ftp, remotePath);
    for (const c of children) {
      if (c.name === '.' || c.name === '..') continue;
      const r = await ftpDeleteRecursive(ftp, c.path, c.isDirectory);
      deleted += r.deleted;
      errors.push(...r.errors);
    }
    try {
      await ftpDeleteRemote(ftp, remotePath);
      deleted++;
    } catch (e) {
      errors.push(`${remotePath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    errors.push(`${remotePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { deleted, errors };
}

export async function ftpMkdirRemote(ftp: FtpConfig, remoteFullPath: string): Promise<void> {
  await NativeFtp.mkdir({
    ...cfgToOpts(ftp, ftp.remoteRoot),
    remotePath: remoteFullPath,
    targetPath: remoteFullPath,
  });
}

export async function ftpUploadModifiedProject(project: WorkProject, modified: string[]): Promise<string[]> {
  const uploaded: string[] = [];
  const prefix = project.pathPrefix || '';
  for (const rel of modified) {
    const localPath = `agent-app/projects/${project.id}/${rel}`;
    const remoteRel = prefix ? `${prefix}/${rel}` : rel;
    try {
      await ftpUploadFile(project.ftp, localPath, remoteRel);
      uploaded.push(rel);
    } catch (e) {
      console.error('FTP upload failed', rel, e);
    }
  }
  return uploaded;
}

export async function readSandboxForUpload(projectId: string, rel: string): Promise<string> {
  const r = await Filesystem.readFile({
    path: `agent-app/projects/${projectId}/${rel}`,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  });
  return typeof r.data === 'string' ? r.data : '';
}

export { NativeFtp };
