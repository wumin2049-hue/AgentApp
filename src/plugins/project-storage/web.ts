import { WebPlugin } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import type {
  AgentProjectStoragePlugin,
  ExportFilesOptions,
  ExportFilesResult,
  SyncTreeOptions,
  SyncTreeResult,
  TreeListResult,
  TreeTextOptions,
  TreeWriteTextOptions,
} from './definitions';

const WEB_ROOT = 'agent-app/chat-tree';

function normRel(path: string): string {
  return path.replace(/^\/+/, '').replace(/\\/g, '/');
}

function rootKey(treeUri: string): string {
  const raw = (treeUri || 'default').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48);
  return raw || 'default';
}

function fullPath(treeUri: string, rel: string): string {
  const base = `${WEB_ROOT}/${rootKey(treeUri)}`;
  const n = normRel(rel);
  return n ? `${base}/${n}` : base;
}

async function ensureParent(path: string): Promise<void> {
  const dir = path.split('/').slice(0, -1).join('/');
  if (!dir) return;
  try {
    await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true });
  } catch {
    /* exists */
  }
}

export class AgentProjectStorageWeb extends WebPlugin implements AgentProjectStoragePlugin {
  async syncTree(_options: SyncTreeOptions): Promise<SyncTreeResult> {
    return {
      copied: 0,
      skipped: 0,
      bytes: 0,
      errors: ['Web 预览不支持目录同步，请使用 Android 真机'],
    };
  }

  async listSandbox(): Promise<{ files: string[] }> {
    return { files: [] };
  }

  async exportFiles(_options: ExportFilesOptions): Promise<ExportFilesResult> {
    return { exported: 0, errors: ['Web 预览不支持写回手机目录'] };
  }

  async writeTreeText(options: TreeWriteTextOptions): Promise<void> {
    const path = fullPath(options.treeUri, options.path);
    await ensureParent(path);
    await Filesystem.writeFile({
      path,
      data: options.data,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
  }

  async readTreeText(options: TreeTextOptions): Promise<{ data: string }> {
    try {
      const r = await Filesystem.readFile({
        path: fullPath(options.treeUri, options.path),
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      return { data: typeof r.data === 'string' ? r.data : '' };
    } catch {
      throw new Error('文件不存在');
    }
  }

  async deleteTreePath(options: TreeTextOptions): Promise<void> {
    const path = fullPath(options.treeUri, options.path);
    try {
      const stat = await Filesystem.stat({ path, directory: Directory.Data });
      if (stat.type === 'directory') {
        await Filesystem.rmdir({ path, directory: Directory.Data, recursive: true });
      } else {
        await Filesystem.deleteFile({ path, directory: Directory.Data });
      }
    } catch {
      /* missing ok */
    }
  }

  async listTreeDir(options: TreeTextOptions): Promise<TreeListResult> {
    try {
      const r = await Filesystem.readdir({
        path: fullPath(options.treeUri, options.path || ''),
        directory: Directory.Data,
      });
      return {
        names: (r.files || []).map((f) => (typeof f === 'string' ? f : f.name)),
      };
    } catch {
      return { names: [] };
    }
  }

  async pickAndPersistDirectory(): Promise<{ uri: string; label: string; persisted?: boolean; canWrite?: boolean }> {
    return {
      uri: 'local://app-data',
      label: '本机预览数据目录',
      persisted: true,
      canWrite: true,
    };
  }

  async persistTreeUri(_options: { treeUri: string }): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: 'web noop' };
  }

  async verifyTreeAccess(_options: { treeUri: string }): Promise<{ ok: boolean; canWrite?: boolean; names?: string[] }> {
    return { ok: true, canWrite: true, names: [] };
  }
}
