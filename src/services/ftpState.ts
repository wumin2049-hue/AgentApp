import { Preferences } from '@capacitor/preferences';
import { useAgentSettingsStore } from '@/stores/agentSettings';
import { loadFtpStateFromDataRoot, saveFtpStateToDataRoot } from '@/services/appDataFs';

const KEY = 'abs_ftp_browser_state';

export interface FtpBrowserState {
  tab: 'local' | 'remote';
  localPath: string;
  remotePath: string;
}

type StateMap = Record<string, FtpBrowserState>;

async function readMap(): Promise<StateMap> {
  const raw = await Preferences.get({ key: KEY });
  if (!raw.value) {
    try {
      const settings = useAgentSettingsStore();
      if (settings.chatStorageRoot) {
        const fromDisk = await loadFtpStateFromDataRoot(settings.chatStorageRoot);
        if (fromDisk) return fromDisk;
      }
    } catch {
      /* pinia 未就绪 */
    }
    return {};
  }
  try {
    return JSON.parse(raw.value) as StateMap;
  } catch {
    return {};
  }
}

async function writeMap(map: StateMap): Promise<void> {
  await Preferences.set({ key: KEY, value: JSON.stringify(map) });
  try {
    const settings = useAgentSettingsStore();
    if (settings.chatStorageRoot?.uri) {
      await saveFtpStateToDataRoot(settings.chatStorageRoot, map);
    }
  } catch {
    /* ignore */
  }
}

export async function loadFtpState(projectId: string): Promise<FtpBrowserState | null> {
  const map = await readMap();
  return map[projectId] || null;
}

export async function saveFtpState(projectId: string, state: FtpBrowserState): Promise<void> {
  const map = await readMap();
  map[projectId] = state;
  await writeMap(map);
}
