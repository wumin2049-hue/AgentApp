import type { HarnessDigest, ToolLogEntry } from '@/types';

export type { HarnessDigest };

const DIGEST_KEY = 'agent_harness_digest';
const MAX_DIGEST_READ = 80;
const MAX_DIGEST_MOD = 40;
const MAX_DIGEST_GREP = 30;
const MAX_TAIL = 36;
const READ_STREAK_NUDGE = 2;
const READ_STREAK_FORCE = 3;

export const HARNESS_WRITE_TOOLS = new Set(['search_replace', 'write_file', 'delete_file']);

const EDIT_INTENT_RE =
  /改|美化|样式|修复|优化|更新|写入|落盘|实现|添加|删除|新增|重构|替换|css|style|refactor|fix|update|implement|modify|edit|修改|换成|调整|创建|生成/i;

export function emptyDigest(): HarnessDigest {
  return { modified_files: [], read_files: [], grep_keys: [] };
}

function digestStorageKey(projectId: string, sessionId?: string): string {
  return sessionId
    ? `${DIGEST_KEY}:${projectId}:${sessionId}`
    : `${DIGEST_KEY}:${projectId}`;
}

export function loadHarnessDigest(projectId: string, sessionId?: string): HarnessDigest {
  try {
    const raw =
      (sessionId && localStorage.getItem(digestStorageKey(projectId, sessionId))) ||
      localStorage.getItem(digestStorageKey(projectId));
    if (!raw) return emptyDigest();
    const parsed = JSON.parse(raw) as Partial<HarnessDigest>;
    return {
      modified_files: Array.isArray(parsed.modified_files) ? parsed.modified_files : [],
      read_files: Array.isArray(parsed.read_files) ? parsed.read_files : [],
      grep_keys: Array.isArray(parsed.grep_keys) ? parsed.grep_keys : [],
    };
  } catch {
    return emptyDigest();
  }
}

export function saveHarnessDigest(
  projectId: string,
  digest: HarnessDigest,
  sessionId?: string,
): void {
  localStorage.setItem(digestStorageKey(projectId, sessionId), JSON.stringify(digest));
}

export function clearHarnessDigest(projectId: string, sessionId?: string): void {
  if (sessionId) {
    localStorage.removeItem(digestStorageKey(projectId, sessionId));
  }
  localStorage.removeItem(digestStorageKey(projectId));
}

function uniqTail(list: string[], value: string, max: number): void {
  const v = value.trim();
  if (!v) return;
  const i = list.indexOf(v);
  if (i >= 0) list.splice(i, 1);
  list.push(v);
  while (list.length > max) list.shift();
}

export function harnessDigestMerge(digest: HarnessDigest, patch: Partial<HarnessDigest>): HarnessDigest {
  const next = {
    modified_files: [...digest.modified_files],
    read_files: [...digest.read_files],
    grep_keys: [...digest.grep_keys],
  };
  for (const f of patch.modified_files ?? []) uniqTail(next.modified_files, f, MAX_DIGEST_MOD);
  for (const f of patch.read_files ?? []) uniqTail(next.read_files, f, MAX_DIGEST_READ);
  for (const k of patch.grep_keys ?? []) uniqTail(next.grep_keys, k, MAX_DIGEST_GREP);
  return next;
}

export function harnessDigestFromToolLog(
  digest: HarnessDigest,
  entries: Array<ToolLogEntry & { args?: Record<string, unknown> }>,
): HarnessDigest {
  let next = digest;
  for (const row of entries) {
    const name = row.name;
    const path = String(row.path || '').trim();
    const args = row.args ?? {};
    if (name === 'read_file' && path) {
      next = harnessDigestMerge(next, { read_files: [path] });
    }
    if (name === 'grep') {
      const pattern = String(args.pattern || '').trim();
      if (pattern) {
        const key = pattern + (path ? ` @${path}` : '');
        next = harnessDigestMerge(next, { grep_keys: [key] });
      }
    }
    if (row.ok && HARNESS_WRITE_TOOLS.has(name) && path) {
      next = harnessDigestMerge(next, { modified_files: [path] });
    }
  }
  return next;
}

export function harnessDigestFormat(digest: HarnessDigest): string {
  const parts: string[] = [];
  if (digest.modified_files.length) {
    parts.push('本会话已修改：' + digest.modified_files.slice(-20).join('、'));
  }
  if (digest.read_files.length) {
    parts.push('本会话已读过：' + digest.read_files.slice(-25).join('、'));
  }
  if (digest.grep_keys.length) {
    parts.push('本会话已搜索：' + digest.grep_keys.slice(-12).join('、'));
  }
  if (!parts.length) return '';
  return '【会话工具记忆】' + parts.join('；') + '。不要重复 read/grep 已处理过的路径。';
}

export function wantsEdit(text: string): boolean {
  return EDIT_INTENT_RE.test(text.trim());
}

export function wantsEditFromMessages(messages: unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: string };
    if (m.role !== 'user') continue;
    const content = String(m.content || '');
    if (content.startsWith('【系统】')) continue;
    return wantsEdit(content);
  }
  return false;
}

export function filterWriteToolDefs(tools: unknown[]): unknown[] {
  return tools.filter((t) => {
    const name = String((t as { function?: { name?: string } }).function?.name || '');
    return HARNESS_WRITE_TOOLS.has(name);
  });
}

export function harnessToolOutputLimit(toolName: string): number {
  if (toolName === 'read_file') return 24000;
  if (toolName === 'grep') return 8000;
  return 6000;
}

export function truncateToolOutput(toolName: string, text: string): string {
  const limit = harnessToolOutputLimit(toolName);
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n…（已截断至 ${limit} 字符，可分段 read_file 继续）`;
}

export function readCacheKey(name: string, args: Record<string, unknown>): string {
  const path = String(args.path || '').trim();
  if (name === 'read_file') return `read:${path}`;
  if (name === 'grep') return `grep:${String(args.pattern || '').trim()}:${path}`;
  if (name === 'glob') return `glob:${String(args.glob_pattern || '').trim()}`;
  if (name === 'list_dir') return `list:${path}`;
  return `${name}:${JSON.stringify(args)}`;
}

export function duplicateReadMessage(name: string, args: Record<string, unknown>): string {
  const path = String(args.path || '').trim();
  if (name === 'read_file') {
    return `【重复读取】文件 ${path} 在本轮已读过。请用上下文里已有内容直接 search_replace，不要再 read_file。`;
  }
  if (name === 'grep') {
    return `【重复搜索】pattern「${String(args.pattern || '')}」在本轮已执行过。请用已有匹配结果继续改代码。`;
  }
  if (name === 'glob') {
    return `【重复 glob】${String(args.glob_pattern || '')} 在本轮已执行过。`;
  }
  if (name === 'list_dir') {
    return `【重复列目录】${path || '/'} 在本轮已列过。请用 grep/glob 精准定位。`;
  }
  return `【重复工具】${name} 在本轮已调用过，请继续落盘或总结。`;
}

export function readStreakMessage(streak: number): string {
  return (
    `【系统】你已经连续 ${streak} 轮只做查找/读取，没有任何一次落盘。` +
    '不要再读更多文件：用现在已经掌握的代码片段立刻调用 search_replace（局部改）或 write_file（新建/整文件重写）完成修改，' +
    '落盘成功后再用一两句话总结。若不确定要改的位置，就把 read_file 读到的原始片段原样作为 old_string。'
  );
}

export function forceWriteMessage(): string {
  return (
    '【系统】本轮只提供写入类工具（search_replace / write_file / delete_file），读取工具已暂时禁用。' +
    '你必须直接落盘：用已读到的内容构造 old_string 做 search_replace，或对目标文件整体 write_file。' +
    '如果 old_string 记不准，就改用 write_file 写整份文件。'
  );
}

export function roundsLowEditMessage(): string {
  return '【系统】工具轮次即将用尽。若用户要求改代码/样式，请优先调用 search_replace 或 write_file 落盘，然后再总结。';
}

type ApiMessage = { role?: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string };

export function balanceMessages(messages: unknown[]): unknown[] {
  const out: unknown[] = [];
  let pending: string[] = [];

  for (const m of messages) {
    const msg = m as ApiMessage;
    const role = String(msg.role || '');

    if (role === 'tool') {
      const id = String(msg.tool_call_id || '');
      const at = pending.indexOf(id);
      if (at < 0) continue;
      pending.splice(at, 1);
      out.push(m);
      continue;
    }

    if (role === 'assistant' && msg.tool_calls?.length) {
      pending = (msg.tool_calls as Array<{ id?: string }>).map((tc) => String(tc.id || ''));
      out.push(m);
      continue;
    }

    out.push(m);
  }

  if (pending.length) {
    for (let i = out.length - 1; i >= 0; i--) {
      const msg = out[i] as ApiMessage;
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        out.splice(i, 1);
        break;
      }
    }
  }

  let firstBody = -1;
  for (let i = 0; i < out.length; i++) {
    if ((out[i] as ApiMessage).role !== 'system') {
      firstBody = i;
      break;
    }
  }
  if (firstBody >= 0 && (out[firstBody] as ApiMessage).role !== 'user') {
    out.splice(firstBody, 1);
  }

  return out;
}

export function pruneMessages(messages: unknown[]): unknown[] {
  if (messages.length <= 40) return balanceMessages(messages);

  const system: unknown[] = [];
  const rest: unknown[] = [];
  for (const m of messages) {
    if ((m as ApiMessage).role === 'system') system.push(m);
    else rest.push(m);
  }

  let firstUser: unknown = null;
  const tail: unknown[] = [];
  for (const m of rest) {
    const msg = m as ApiMessage;
    if (
      !firstUser &&
      msg.role === 'user' &&
      !String(msg.content || '').startsWith('【系统】')
    ) {
      firstUser = m;
      continue;
    }
    tail.push(m);
  }

  const clipped = tail.length > MAX_TAIL ? tail.slice(-MAX_TAIL) : tail;
  const merged = [...system];
  if (firstUser) merged.push(firstUser);
  return balanceMessages([...merged, ...clipped]);
}

export const READ_STREAK_NUDGE_AT = READ_STREAK_NUDGE;
export const READ_STREAK_FORCE_AT = READ_STREAK_FORCE;
