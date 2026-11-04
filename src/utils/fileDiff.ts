import type { FileDiffSnippet } from '@/types';

const MAX_SNIPPET = 2400;
const MAX_LINES = 400;
const MAX_DP_CELLS = 80_000;
const MAX_OUT_LINES = 160;

export function clipText(text: string, max = MAX_SNIPPET): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`;
}

/** 行级 LCS → unified（过大则回退前后片段对照） */
function lineUnified(path: string, before: string, after: string): string {
  const a = (before || '').split('\n');
  const b = (after || '').split('\n');
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`, '@@'];

  if (
    a.length > MAX_LINES ||
    b.length > MAX_LINES ||
    a.length * b.length > MAX_DP_CELLS
  ) {
    lines.push('…（文件较大，仅展示首尾片段）');
    for (const line of a.slice(0, 30)) lines.push(`-${line}`);
    if (a.length > 30) lines.push(`-…(+${a.length - 30} 行)`);
    for (const line of b.slice(0, 30)) lines.push(`+${line}`);
    if (b.length > 30) lines.push(`+…(+${b.length - 30} 行)`);
    return lines.join('\n');
  }

  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? (dp[i - 1][j - 1] + 1) as number
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  type Op = { t: ' ' | '+' | '-'; s: string };
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ t: ' ', s: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ t: '+', s: b[j - 1] });
      j--;
    } else {
      ops.push({ t: '-', s: a[i - 1] });
      i--;
    }
  }
  ops.reverse();

  // 压缩大段上下文：连续相同行超过 3 行则折叠
  const compact: Op[] = [];
  let sameRun = 0;
  for (const op of ops) {
    if (op.t === ' ') {
      sameRun++;
      if (sameRun <= 2) compact.push(op);
      else if (sameRun === 3) compact.push({ t: ' ', s: '…' });
    } else {
      sameRun = 0;
      compact.push(op);
    }
  }

  const out = compact.slice(0, MAX_OUT_LINES);
  for (const op of out) lines.push(`${op.t}${op.s}`);
  if (compact.length > MAX_OUT_LINES) {
    lines.push(`…（另有 ${compact.length - MAX_OUT_LINES} 行未展示）`);
  }
  return lines.join('\n');
}

/** 粗算增删行数（供写入时间线展示 +N -M） */
export function countLineDelta(
  before: string,
  after: string,
  kind: FileDiffSnippet['kind'] = 'replace',
): { added: number; removed: number } {
  const bRaw = before || '';
  const aRaw = after || '';
  const bN = bRaw ? bRaw.split('\n').length : 0;
  const aN = aRaw ? aRaw.split('\n').length : 0;
  if (kind === 'delete') return { added: 0, removed: Math.max(bN, 1) };
  if (kind === 'write' && !bRaw) return { added: Math.max(aN, 1), removed: 0 };
  return { added: aN, removed: bN };
}

/** 生成审阅用 unified 片段 */
export function buildUnifiedSnippet(
  path: string,
  before: string,
  after: string,
  kind: FileDiffSnippet['kind'] = 'replace',
): FileDiffSnippet {
  const bRaw = before || '';
  const aRaw = after || '';
  const b = clipText(bRaw);
  const a = clipText(aRaw);
  const delta = countLineDelta(bRaw, aRaw, kind);

  let unified: string;
  if (kind === 'delete') {
    const lines = [`--- a/${path}`, `+++ /dev/null`, '@@'];
    for (const line of bRaw.split('\n').slice(0, 80)) lines.push(`-${line}`);
    if (bRaw.split('\n').length > 80) lines.push('-…');
    unified = lines.join('\n');
  } else if (kind === 'write' && !bRaw) {
    const lines = [`--- /dev/null`, `+++ b/${path}`, '@@'];
    for (const line of aRaw.split('\n').slice(0, 80)) lines.push(`+${line}`);
    if (aRaw.split('\n').length > 80) lines.push('+…');
    unified = lines.join('\n');
  } else {
    unified = lineUnified(path, bRaw, aRaw);
  }

  return {
    path,
    kind,
    before: b || undefined,
    after: kind === 'delete' ? undefined : a || undefined,
    unified,
    added: delta.added,
    removed: delta.removed,
  };
}
