import type { WorkProject } from '@/types';
import { readProjectFile } from './localFs';

/** 规范化工具 path：去前导斜杠、禁止 .. 穿越 */
export function normToolPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\\/g, '/').trim();
}

const RULE_FILES = ['AGENTS.md', '.mincode/rules.md', 'RULES.md', '.cursorrules'];

/** 项目 Rules：设置里的 rules 优先，否则尝试沙盒内约定文件 */
export async function loadProjectRulesText(project: WorkProject): Promise<string> {
  const inline = project.rules?.trim();
  if (inline) return inline;
  for (const rel of RULE_FILES) {
    try {
      const text = await readProjectFile(project, rel);
      if (text?.trim()) return text.trim();
    } catch {
      /* try next */
    }
  }
  return '';
}

/** 工作区前缀（空 = 整个项目根） */
export function scopePrefix(workRoot: string): string {
  const w = normToolPath(workRoot).replace(/\/+$/, '');
  return w;
}

/** 解析并限定到工作区内；越界返回 null */
export function resolveScopedPath(path: string, workRoot: string): string | null {
  let p = normToolPath(path);
  if (!p) return scopePrefix(workRoot) || '';
  if (p.split('/').some((seg) => seg === '..')) return null;

  const prefix = scopePrefix(workRoot);
  if (prefix) {
    if (p === prefix || p.startsWith(prefix + '/')) {
      return p;
    }
    p = `${prefix}/${p}`;
  }

  if (p.split('/').some((seg) => seg === '..')) return null;
  return p;
}

export function isScopedPath(path: string, workRoot: string): boolean {
  const resolved = resolveScopedPath(path, workRoot);
  if (resolved === null) return false;
  const prefix = scopePrefix(workRoot);
  if (!prefix) return true;
  return resolved === prefix || resolved.startsWith(prefix + '/');
}

export function scopeLabel(workRoot: string): string {
  const p = scopePrefix(workRoot);
  return p ? `${p}/` : '/（项目根）';
}

export function buildAgentSystemPrompt(
  projectName: string,
  localRootLabel: string,
  workRoot: string,
  customPrompt?: string,
  harnessNote?: string,
  projectRules?: string,
): string {
  const ws = scopePrefix(workRoot);
  const wsLine = ws
    ? `当前工作区（AI 仅能操作此目录及其子路径）：\`${ws}/\`\n工具参数 path 必须以此开头，例如 \`${ws}/src/App.vue\`。`
    : `当前工作区：整个项目根目录 \`/\`。\n工具参数 path 为相对项目根的路径，例如 \`src/App.vue\`。`;

  const base =
    `你是移动端代码 Agent，正在项目「${projectName}」中工作。\n\n` +
    `【手机绑定目录】${localRootLabel}\n` +
    `【沙盒项目根】/（所有工具 path 均相对此根，不得使用 .. 跳出项目）\n` +
    `【${wsLine}】\n\n` +
    `规则：\n` +
    `- 只能读写工作区内的文件\n` +
    `- 修改后简要总结改了哪些文件\n` +
    `- 优先 search_replace，避免无谓重复 read`;

  let out = base;
  if (harnessNote?.trim()) {
    out += `\n\n${harnessNote.trim()}`;
  }
  if (projectRules?.trim()) {
    out += `\n\n【项目 Rules】\n${projectRules.trim().slice(0, 8000)}`;
  }
  if (customPrompt?.trim()) {
    out += `\n\n【全局补充说明】\n${customPrompt.trim()}`;
  }
  return out;
}
