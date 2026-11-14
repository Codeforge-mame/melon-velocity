import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Notifications from 'expo-notifications';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

import {
  DownloadItem,
  DownloadMode,
  getAllDownloads,
  insertDownload,
  updateDownloadState,
  deleteDownloadRecord,
} from '../db/database';
import { resolveMediaUrl, VideoQuality } from './cobalt';

// Configure how notifications behave when the app is open
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// Keep active FileSystem.DownloadResumable instances in memory for pause/resume
const activeTasks = new Map<string, FileSystem.DownloadResumable>();

// Throttle SQLite writes during fast progress ticks (max once every 600ms per download)
const lastDbSync = new Map<string, number>();

// Optional UI listener so your screens re-render smoothly on state changes
type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeDownloads(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyUI() {
  listeners.forEach((fn) => fn());
}

// --- 1. Request Notification Permissions & Setup Android Channel ---
export async function ensureNotificationPermissions(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('rooster-downloads', {
      name: 'Rooster Downloads',
      importance: Notifications.AndroidImportance.LOW,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  if (existingStatus === 'granted') return true;

  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

async function sendDownloadNotification(title: string, body: string, id: string) {
  const granted = await ensureNotificationPermissions();
  if (!granted) return;

  await Notifications.scheduleNotificationAsync({
    identifier: `dl-${id}`,
    content: {
      title,
      body,
      sound: false,
    },
    trigger: null, // Deliver immediately
  });
}

// --- 2. Start a Brand New Download ---
export async function startNewDownload(
  sourceUrl: string,
  mode: DownloadMode,
  quality: VideoQuality
): Promise<string> {
  await ensureNotificationPermissions();

  const id = Crypto.randomUUID();

  // Create initial 'queued' record immediately so UI shows instant feedback
  await insertDownload({
    id,
    source_url: sourceUrl,
    resolved_url: null,
    title: 'Resolving link...',
    filename: `rooster_${Date.now()}.mp4`,
    mode,
    quality,
    status: 'queued',
    progress: 0,
    resume_data: null,
    local_uri: null,
    saved_to_gallery: 0,
    error_message: null,
  });
  notifyUI();

  try {
    // Resolve direct stream via your Railway Cobalt instance
    const resolved = await resolveMediaUrl({ url: sourceUrl, mode, quality });

    // Update record with real title, filename, and resolved stream URL
    const db = await import('../db/database').then((m) => m.getDB());
    await db.runAsync(
      'UPDATE downloads SET title = ?, filename = ?, resolved_url = ?, status = ? WHERE id = ?',
      [resolved.title, resolved.filename, resolved.streamUrl, 'downloading', id]
    );
    notifyUI();

    await sendDownloadNotification('Downloading started', resolved.title, id);

    // Begin actual file download
    await executeDownloadTask(id, resolved.streamUrl, resolved.filename, resolved.title);
    return id;
  } catch (err: any) {
    const message = err?.message || 'Failed to resolve media link.';
    await updateDownloadState(id, {
      status: 'failed',
      error_message: message,
    });
    notifyUI();
    await sendDownloadNotification('Download failed', message, id);
    throw err;
  }
}

// --- Core Download Executor ---
async function executeDownloadTask(
  id: string,
  streamUrl: string,
  filename: string,
  title: string,
  savedResumeData?: string | null
) {
  const fileUri = `${FileSystem.documentDirectory}${filename}`;

  const onProgress = async (progressEvent: FileSystem.DownloadProgressData) => {
    const { totalBytesWritten, totalBytesExpectedToWrite } = progressEvent;
    const ratio =
      totalBytesExpectedToWrite > 0
        ? Math.min(totalBytesWritten / totalBytesExpectedToWrite, 1)
        : 0;

    const now = Date.now();
    const last = lastDbSync.get(id) || 0;
    if (now - last > 600 || ratio >= 1) {
      lastDbSync.set(id, now);
      await updateDownloadState(id, { progress: ratio });
      notifyUI();
    }
  };

  const downloadResumable = savedResumeData
    ? new FileSystem.DownloadResumable(
        streamUrl,
        fileUri,
        {},
        onProgress,
        savedResumeData
      )
    : FileSystem.createDownloadResumable(streamUrl, fileUri, {}, onProgress);

  activeTasks.set(id, downloadResumable);

  try {
    const result = savedResumeData
      ? await downloadResumable.resumeAsync()
      : await downloadResumable.downloadAsync();

    activeTasks.delete(id);
    lastDbSync.delete(id);

    // If result is undefined, the user paused the download intentionally
    if (!result) return;

    if (result.status >= 400) {
      throw new Error(`Server returned HTTP ${result.status}`);
    }

    await updateDownloadState(id, {
      status: 'completed',
      progress: 1,
      local_uri: result.uri,
      resume_data: null,
      error_message: null,
    });
    notifyUI();

    await sendDownloadNotification('Download complete', title, id);
  } catch (err: any) {
    activeTasks.delete(id);
    lastDbSync.delete(id);

    // Ignore abort errors caused when user taps Pause
    const currentItems = await getAllDownloads();
    const current = currentItems.find((item) => item.id === id);
    if (current?.status === 'paused') return;

    const message = err?.message || 'Download interrupted.';
    await updateDownloadState(id, {
      status: 'failed',
      error_message: message,
    });
    notifyUI();

    await sendDownloadNotification('Download failed', `${title}: ${message}`, id);
  }
}

// --- 3. Pause Download ---
export async function pauseDownload(id: string): Promise<void> {
  const task = activeTasks.get(id);

  await updateDownloadState(id, { status: 'paused' });
  notifyUI();

  if (task) {
    try {
      const snapshot = await task.pauseAsync();
      activeTasks.delete(id);
      await updateDownloadState(id, {
        status: 'paused',
        resume_data: snapshot?.resumeData || null,
      });
      notifyUI();
    } catch {
      // Even if pauseAsync throws on certain streams, state is marked paused
      activeTasks.delete(id);
    }
  }
}

// --- 4. Resume Download ---
export async function resumeDownload(item: DownloadItem): Promise<void> {
  if (!item.resolved_url) {
    return retryDownload(item);
  }

  await updateDownloadState(item.id, {
    status: 'downloading',
    error_message: null,
  });
  notifyUI();

  await executeDownloadTask(
    item.id,
    item.resolved_url,
    item.filename,
    item.title,
    item.resume_data
  );
}

// --- 5. Retry Download (Auto-refreshes expired Cobalt link!) ---
export async function retryDownload(item: DownloadItem): Promise<void> {
  await updateDownloadState(item.id, {
    status: 'queued',
    progress: 0,
    resume_data: null,
    error_message: null,
  });
  notifyUI();

  try {
    // Re-query Cobalt so expired tunnel URLs never block a retry
    const resolved = await resolveMediaUrl({
      url: item.source_url,
      mode: item.mode,
      quality: item.quality as VideoQuality,
    });

    await updateDownloadState(item.id, {
      status: 'downloading',
      resolved_url: resolved.streamUrl,
    });
    notifyUI();

    await executeDownloadTask(item.id, resolved.streamUrl, item.filename, item.title);
  } catch (err: any) {
    await updateDownloadState(item.id, {
      status: 'failed',
      error_message: err?.message || 'Retry failed.',
    });
    notifyUI();
  }
}

// --- 6. Save Downloaded File to Device Gallery ---
export async function saveItemToGallery(item: DownloadItem): Promise<void> {
  if (!item.local_uri) {
    throw new Error('File not found on device.');
  }

  const { status } = await MediaLibrary.requestPermissionsAsync();
  if (status !== 'granted') {
    throw new Error('Gallery permission is required to save media.');
  }

  await MediaLibrary.saveToLibraryAsync(item.local_uri);

  await updateDownloadState(item.id, { saved_to_gallery: 1 });
  notifyUI();
}

// --- 7. Delete Download & Clean Local File ---
export async function removeDownload(item: DownloadItem): Promise<void> {
  const task = activeTasks.get(item.id);
  if (task) {
    try {
      await task.pauseAsync();
    } catch {}
    activeTasks.delete(item.id);
  }

  if (item.local_uri) {
    try {
      await FileSystem.deleteAsync(item.local_uri, { idempotent: true });
    } catch {}
  }

  await deleteDownloadRecord(item.id);
  notifyUI();
}