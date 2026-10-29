<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ChatMessage } from '@/types';
import { renderMarkdown } from '@/utils/markdown';

const props = defineProps<{
  message: ChatMessage;
  /** 本条正在流式输出（同一气泡内） */
  streaming?: boolean;
  deletable?: boolean;
}>();

const emit = defineEmits<{
  delete: [id: string];
}>();

/** 流式用纯文本，定稿后再渲染 MD（减掉帧） */
const finalizedHtml = ref('');
let mdTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFinalMd(content: string) {
  if (mdTimer) clearTimeout(mdTimer);
  mdTimer = setTimeout(() => {
    finalizedHtml.value = content ? renderMarkdown(content) : '';
    mdTimer = null;
  }, 60);
}

watch(
  () => [props.message.content, props.streaming, props.message.role] as const,
  ([content, streaming, role]) => {
    if (role !== 'assistant') {
      finalizedHtml.value = '';
      return;
    }
    if (streaming) {
      finalizedHtml.value = '';
      return;
    }
    scheduleFinalMd(content || '');
  },
  { immediate: true },
);

const showStreamText = computed(
  () =>
    props.message.role === 'assistant' &&
    Boolean(props.streaming) &&
    Boolean(props.message.content),
);

const showPlaceholder = computed(
  () =>
    props.message.role === 'assistant' &&
    Boolean(props.streaming) &&
    !props.message.content,
);

function onDelete() {
  if (!props.deletable) return;
  emit('delete', props.message.id);
}

async function onMdClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement | null)?.closest?.('[data-act="copy-code"]') as
    | HTMLButtonElement
    | null;
  if (!btn) return;
  e.preventDefault();
  const block = btn.closest('.code-block');
  const code = block?.querySelector('code')?.textContent || '';
  try {
    await navigator.clipboard.writeText(code);
    btn.classList.add('done');
    const prev = btn.textContent;
    btn.textContent = '已复制';
    window.setTimeout(() => {
      btn.classList.remove('done');
      btn.textContent = prev || '复制';
    }, 1400);
  } catch {
    btn.textContent = '失败';
  }
}
</script>

<template>
  <div v-if="message.role === 'user'" class="msg-user msg-row">
    <div class="msg-body">{{ message.content }}</div>
    <button
      v-if="deletable"
      type="button"
      class="msg-del"
      title="删除此条"
      @click="onDelete"
    >
      ×
    </button>
  </div>
  <div v-else class="msg-assistant msg-row">
    <div class="msg-body">
      <details v-if="message.reasoning" class="reasoning-block">
        <summary>思考过程</summary>
        <pre>{{ message.reasoning }}</pre>
      </details>

      <!-- 流式：同一气泡内纯文本，避免每 delta 全量 MD -->
      <pre v-if="showStreamText" class="msg-stream-text">{{ message.content }}</pre>
      <span v-else-if="showPlaceholder" class="msg-placeholder">…</span>
      <div
        v-else-if="finalizedHtml"
        class="md"
        v-html="finalizedHtml"
        @click="onMdClick"
      />
      <span v-else-if="message.content" class="msg-body-plain">{{ message.content }}</span>
    </div>
    <button
      v-if="deletable && !streaming"
      type="button"
      class="msg-del"
      title="删除此条"
      @click="onDelete"
    >
      ×
    </button>
  </div>
</template>
