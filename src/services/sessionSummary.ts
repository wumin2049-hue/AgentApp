import { chatTurn } from '@/api/agentServer';
import type { AgentServerConfig, ChatMessage, HarnessDigest } from '@/types';
import { harnessDigestFormat } from '@/services/harness';

/**
 * 将较早对话压缩为一条摘要（可选 LLM；失败则规则摘要）。
 * 保留最近 keepTail 条 user/assistant，中间替换为摘要对。
 */
export async function compressChatHistory(
  cfg: AgentServerConfig,
  messages: ChatMessage[],
  digest: HarnessDigest,
  keepTail = 8,
  signal?: AbortSignal,
): Promise<ChatMessage[]> {
  const body = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (body.length <= keepTail + 2) return messages;

  const head = body[0];
  const mid = body.slice(1, Math.max(1, body.length - keepTail));
  const tail = body.slice(-keepTail);
  const digestNote = harnessDigestFormat(digest);

  const midBlob = mid
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content.slice(0, 400)}`)
    .join('\n')
    .slice(0, 6000);

  let summaryText = '';
  const model = cfg.model?.trim();
  if (model && cfg.apiBaseUrl?.trim() && cfg.apiKey?.trim()) {
    try {
      const turn = await chatTurn(
        cfg,
        [
          {
            role: 'system',
            content:
              '你是会话摘要助手。用中文输出 8～15 行要点：用户目标、已改/已读关键文件、未决问题。不要写代码块。',
          },
          {
            role: 'user',
            content:
              `${digestNote ? digestNote + '\n\n' : ''}请摘要以下较早对话：\n\n${midBlob}`,
          },
        ],
        [],
        { model, max_tokens: 600, temperature: 0.2, signal },
      );
      summaryText = (turn.content || '').trim();
    } catch {
      summaryText = '';
    }
  }

  if (!summaryText) {
    const intents = mid
      .filter((m) => m.role === 'user')
      .map((m) => m.content.replace(/\s+/g, ' ').trim().slice(0, 60))
      .filter(Boolean)
      .slice(-10);
    summaryText =
      `较早轮次已压缩。` +
      (intents.length ? `用户曾提到：${intents.join('；')}。` : '') +
      (digestNote || '');
  }

  const now = new Date().toISOString();
  const summaryUser: ChatMessage = {
    id: `m_sum_u_${Date.now()}`,
    role: 'user',
    content: `【历史摘要】\n${summaryText}`,
    createdAt: now,
  };
  const summaryAsst: ChatMessage = {
    id: `m_sum_a_${Date.now()}`,
    role: 'assistant',
    content: '已了解此前目标与进度，继续当前任务即可。',
    createdAt: now,
  };

  const others = messages.filter((m) => m.role === 'system');
  return [...others, head, summaryUser, summaryAsst, ...tail];
}
