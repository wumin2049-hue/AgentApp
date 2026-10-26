<script setup lang="ts">
import { computed } from 'vue';
import type { ChatMessage } from '@/types';
import { parseMessageParts } from '@/utils/messageContent';

const props = defineProps<{
  message: ChatMessage;
  streaming?: boolean;
  deletable?: boolean;
}>();

const emit = defineEmits<{
  delete: [id: string];
}>();

const parts = computed(() =>
  props.message.role === 'assistant' ? parseMessageParts(props.message.content) : [],
);

function onDelete() {
  if (!props.deletable) return;
  emit('delete', props.message.id);
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

      <template v-if="message.content">
        <template v-for="(p, i) in parts" :key="i">
          <span v-if="p.type === 'text'" class="msg-text">{{ p.text }}</span>
          <figure v-else-if="p.type === 'image'" class="msg-figure">
            <img :src="p.url" :alt="p.alt" loading="lazy" />
            <figcaption v-if="p.alt">{{ p.alt }}</figcaption>
          </figure>
          <a v-else :href="p.url" target="_blank" rel="noopener" class="msg-link">{{ p.url }}</a>
        </template>
      </template>
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
