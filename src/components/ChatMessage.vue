<script setup lang="ts">
import { computed } from 'vue';
import type { ChatMessage } from '@/types';
import { renderMarkdown } from '@/utils/markdown';

const props = defineProps<{
  message: ChatMessage;
  streaming?: boolean;
  deletable?: boolean;
}>();

const emit = defineEmits<{
  delete: [id: string];
}>();

const html = computed(() =>
  props.message.role === 'assistant' && props.message.content
    ? renderMarkdown(props.message.content)
    : '',
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

      <div
        v-if="html"
        class="md"
        v-html="html"
        @click="onMdClick"
      />
      <span v-else-if="streaming" class="msg-placeholder">…</span>
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
