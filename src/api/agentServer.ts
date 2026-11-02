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
];
