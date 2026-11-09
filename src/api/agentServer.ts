/**
 * Harness 对齐：直连上游 OpenAI 兼容 API（URL + Key）
 * 本地执行工具循环，模型请求不经 agent PHP relay。
 */
import type { AgentServerConfig } from '@/types';

export {
  normalizeApiBaseUrl,
  normalizeApiBaseUrl as normalizeBaseUrl,
  baseCandidates,
  testAgentConnection,
  fetchModelsFromUpstream,
  upstreamRequest,
  chatTurn,
  chatTurnStream,
} from './upstreamClient';

export type { ConnectionTestResult, ChatTurnResult } from './upstreamClient';

/** @deprecated 直连模式无需 relay */
export async function relayRequest(
  cfg: AgentServerConfig,
  path: string,
  method: 'GET' | 'POST',
  payload: Record<string, unknown> = {},
  idempotency = '',
): Promise<unknown> {
  const { upstreamRequest } = await import('./upstreamClient');
  return upstreamRequest(cfg, path, method, payload, idempotency);
}

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取项目内文本文件',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对项目根的路径' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        '写入或覆盖整个文件（立即落到手机工作区，自动创建父目录）。搭建项目时可连续多次调用，每次一个文件。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '相对项目根路径，如 src/App.vue；深层路径会自动建目录',
          },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_replace',
      description: '局部替换文件内容（改完立即写入手机工作区）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出目录',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: '在项目中搜索文本',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: '按 glob 匹配文件',
      parameters: {
        type: 'object',
        properties: { glob_pattern: { type: 'string' } },
        required: ['glob_pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: '删除文件',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        '向用户弹出选项框询问方案/确认项，等待用户选择后再继续。有多种实现路径或关键决策时必须先调用，不要只在正文里提问就结束。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问用户的问题' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '可选方案列表（2～8 项）',
          },
        },
        required: ['question', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_todos',
      description:
        '创建或更新本轮任务清单。多步任务须首次一次性列出全部步骤；建完后清单锁定，只能按 id 更新 status，禁止执行中新增/删减。必须按顺序：同一时刻仅一项 in_progress，完成后标 completed 再推进下一项，全部 completed 前不要结束。',
      parameters: {
        type: 'object',
        properties: {
          merge: {
            type: 'boolean',
            description:
              'true=按已有 id 合并更新 status（推荐）；false=仅首次建清单时可用。清单锁定后 false 且增减条目会被拒绝。默认 true',
          },
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '稳定唯一 id，如 scaffold / api' },
                content: { type: 'string', description: '任务描述' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                  description:
                    '按序推进：pending → in_progress → completed。禁止用 cancelled 跳过未做项',
                },
              },
              required: ['id', 'content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
];
