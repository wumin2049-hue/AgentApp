/** 解析 AI 正文中的「请选择方案」类提问，供弹框展示 */

export type AskUserRequest = {
  question: string;
  options: string[];
};

export type AskUserHandler = (req: AskUserRequest) => Promise<string | null>;

/** 是否像在向用户征询方案/选项（而非已完成总结） */
export function looksLikeClarifyingQuestion(text: string): boolean {
  const t = String(text || '').trim();
  if (!t || t.length < 8) return false;
  // 已明显在交付代码时不当成提问
  if (/```[\s\S]{40,}```/.test(t) && !/[？?]/.test(t)) return false;

  const asks =
    /[？?]/.test(t) ||
    /请选择|请问|请确认|你希望|想用哪|要哪|哪种|哪一种|是否采用|选一个|要不要|可否|还是/.test(t);
  if (!asks) return false;

  const hasOpts =
    /方案\s*[一二三四1234A-Da-d]|选项\s*[A-D1-4]|(?:^|\n)\s*(?:[-*]|\d+[\.、)]|[A-Da-d][\.、)])\s+\S+/m.test(
      t,
    ) || /还是|或者/.test(t);

  return hasOpts || /是否|要不要|可否|确认一下/.test(t);
}

/** 从正文提取问题与选项 */
export function extractAskOptions(text: string): AskUserRequest {
  const raw = String(text || '').trim();
  const options: string[] = [];
  const seen = new Set<string>();

  const push = (s: string) => {
    const v = s.replace(/\s+/g, ' ').trim();
    if (!v || v.length > 120) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    options.push(v);
  };

  for (const line of raw.split(/\n/)) {
    const m1 = line.match(/^\s*(?:[-*]|\d+[\.、)]|[A-Da-d][\.、)])\s+(.+)$/);
    if (m1) push(m1[1]);
    const m2 = line.match(/^\s*方案\s*[一二三四1234A-Da-d]\s*[：:．.\s]\s*(.+)$/);
    if (m2) push(m2[1]);
    const m3 = line.match(/^\s*选项\s*[A-Da-d1-4]\s*[：:．.\s]\s*(.+)$/);
    if (m3) push(m3[1]);
  }

  // 「用 Vue 还是 React」类
  const orM = raw.match(/([^\n？?]{2,40}?)\s*(?:还是|或者)\s*([^\n？?]{2,40}?)(?:[？?]|$)/);
  if (orM && options.length < 2) {
    push(orM[1]);
    push(orM[2]);
  }

  if (options.length < 2 && /是否|要不要|可否/.test(raw)) {
    push('可以，按这个继续');
    push('换一种方案');
    push('先暂停，我补充需求');
  }

  if (options.length < 2) {
    push('继续执行（按你的推荐）');
    push('先给我完整方案说明');
    push('取消本轮');
  }

  const question = raw.length > 800 ? raw.slice(0, 800) + '…' : raw;
  return { question, options: options.slice(0, 8) };
}
