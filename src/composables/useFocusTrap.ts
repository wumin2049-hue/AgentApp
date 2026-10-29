import { onUnmounted, watch, type Ref } from 'vue';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 简易焦点陷阱：弹层打开时 Tab 循环，关闭后恢复原先焦点。
 */
export function useFocusTrap(active: Ref<boolean>, panelSelector: string) {
  let prev: HTMLElement | null = null;

  function onKeydown(e: KeyboardEvent) {
    if (!active.value || e.key !== 'Tab') return;
    const panel = document.querySelector(panelSelector) as HTMLElement | null;
    if (!panel) return;
    const nodes = [...panel.querySelectorAll(FOCUSABLE)] as HTMLElement[];
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const cur = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (cur === first || !panel.contains(cur)) {
        e.preventDefault();
        last.focus();
      }
    } else if (cur === last) {
      e.preventDefault();
      first.focus();
    }
  }

  watch(active, (on) => {
    if (on) {
      prev = document.activeElement as HTMLElement | null;
      document.addEventListener('keydown', onKeydown, true);
      requestAnimationFrame(() => {
        const panel = document.querySelector(panelSelector) as HTMLElement | null;
        const focusable = panel?.querySelector(FOCUSABLE) as HTMLElement | null;
        focusable?.focus();
      });
    } else {
      document.removeEventListener('keydown', onKeydown, true);
      prev?.focus?.({ preventScroll: true });
      prev = null;
    }
  });

  onUnmounted(() => {
    document.removeEventListener('keydown', onKeydown, true);
  });
}
