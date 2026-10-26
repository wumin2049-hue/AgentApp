export interface SyncTreeOptions {
  /** SAF document-tree URI（pickDirectory 返回的 path） */
  treeUri: string;
  /** 沙盒内项目 ID */
  projectId: string;
  /** 最大复制文件数，防止超大项目卡死 */
  maxFiles?: number;
  /** 单文件最大字节 */
  maxFileBytes?: number;
}

export interface SyncTreeResult {
  copied: number;
  skipped: number;
  bytes: number;
  errors: string[];
}

export interface ExportFilesOptions {
  treeUri: string;
  projectId: string;
  /** 沙盒内相对路径列表 */
  paths: string[];
}

export interface ExportFilesResult {
  exported: number;
  errors: string[];
}

export interface TreeTextOptions {
  /** SAF document-tree URI */
  treeUri: string;
  /** 相对路径，如 projects/p1/index.json */
  path: string;
}

export interface TreeWriteTextOptions extends TreeTextOptions {
  data: string;
}

export interface TreeListResult {
  names: string[];
}

export interface AgentProjectStoragePlugin {
  syncTree(options: SyncTreeOptions): Promise<SyncTreeResult>;
  /** 列出沙盒内项目相对路径（递归） */
  listSandbox(options: { projectId: string }): Promise<{ files: string[] }>;
  /** 将沙盒文件写回 SAF 目录 */
  exportFiles(options: ExportFilesOptions): Promise<ExportFilesResult>;
  /** 在 SAF 树目录下写入 UTF-8 文本（自动建父目录） */
  writeTreeText(options: TreeWriteTextOptions): Promise<void>;
  /** 读取 SAF 树目录下 UTF-8 文本 */
  readTreeText(options: TreeTextOptions): Promise<{ data: string }>;
  /** 删除 SAF 树下文件或目录（目录递归） */
  deleteTreePath(options: TreeTextOptions): Promise<void>;
  /** 列出 SAF 树某目录下的直接子项名称 */
  listTreeDir(options: TreeTextOptions): Promise<TreeListResult>;
}
