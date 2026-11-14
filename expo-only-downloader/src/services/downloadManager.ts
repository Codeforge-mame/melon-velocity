import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Notifications from 'expo-notifications';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as Sharing from 'expo-sharing';
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

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const activeTasks = new Map<string, FileSystem.DownloadResumable>();
const lastDbSync = new Map<string, number>();

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeDownloads(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyUI() {
  listeners.forEach((fn) => fn());
}

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
    content: { title, body, sound: false },
    trigger: null,
  });
}

async function generateAndSaveThumbnail(id: string, videoUri: string): Promise<string | null> {
  try {
    const { uri: tempThumb } = await VideoThumbnails.getThumbnailAsync(videoUri, {
      time: 1000,
      quality: 0.7,
    });
    const destThumb = `${FileSystem.documentDirectory}thumb_${id}.jpg`;
    await FileSystem.copyAsync({ from: tempThumb, to: destThumb });
    return destThumb;
  } catch {
    return null;
  }
}

export async function startNewDownload(
  sourceUrl: string,
  mode: DownloadMode,
  quality: VideoQuality
): Promise<string> {
  await ensureNotificationPermissions();
  const id = Crypto.randomUUID();

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
    thumbnail_uri: null,
    saved_to_gallery: 0,
    error_message: null,
  });
  notifyUI();

  try {
    const resolved = await resolveMediaUrl({ url: sourceUrl, mode, quality });

    const db = await import('../db/database').then((m) => m.getDB());
    await db.runAsync(
      'UPDATE downloads SET title = ?, filename = ?, resolved_url = ?, status = ? WHERE id = ?',
      [resolved.title, resolved.filename, resolved.streamUrl, 'downloading', id]
    );
    notifyUI();

    await sendDownloadNotification('Downloading started', resolved.title, id);
    await executeDownloadTask(id, resolved.streamUrl, resolved.filename, resolved.title, mode);
    return id;
  } catch (err: any) {
    const message = err?.message || 'Failed to resolve media link.';
    await updateDownloadState(id, { status: 'failed', error_message: message });
    notifyUI();
    await sendDownloadNotification('Download failed', message, id);
    throw err;
  }
}

async function executeDownloadTask(
  id: string,
  streamUrl: string,
  filename: string,
  title: string,
  mode: DownloadMode,
  savedResumeData?: string | null
) {
  const fileUri = `${FileSystem.documentDirectory}${filename}`;

  const onProgress = async (progressEvent: FileSystem.DownloadProgressData) => {
    const { totalBytesWritten, totalBytesExpectedToWrite } = progressEvent;
    const ratio =
      totalBytesExpectedToWrite > 0
        ? Math.min(totalBytesWritten / totalBytesExpectedToWrite, 1)
        : 0;

    // 800ms throttle keeps JS bridge fast during concurrent downloads
    const now = Date.now();
    const last = lastDbSync.get(id) || 0;
    if (now - last > 800 || ratio >= 1) {
      lastDbSync.set(id, now);
      await updateDownloadState(id, { progress: ratio });
      notifyUI();
    }
  };

  const downloadResumable = savedResumeData
    ? new FileSystem.DownloadResumable(streamUrl, fileUri, {}, onProgress, savedResumeData)
    : FileSystem.createDownloadResumable(streamUrl, fileUri, {}, onProgress);

  activeTasks.set(id, downloadResumable);

  try {
    const result = savedResumeData
      ? await downloadResumable.resumeAsync()
      : await downloadResumable.downloadAsync();

    activeTasks.delete(id);
    lastDbSync.delete(id);

    if (!result) return;
    if (result.status >= 400) {
      throw new Error(`Server returned HTTP ${result.status}`);
    }

    const thumbnailUri =
      mode !== 'audio' ? await generateAndSaveThumbnail(id, result.uri) : null;

    await updateDownloadState(id, {
      status: 'completed',
      progress: 1,
      local_uri: result.uri,
      thumbnail_uri: thumbnailUri,
      resume_data: null,
      error_message: null,
    });
    notifyUI();

    await sendDownloadNotification('Download complete', title, id);
  } catch (err: any) {
    activeTasks.delete(id);
    lastDbSync.delete(id);

    const currentItems = await getAllDownloads();
    const current = currentItems.find((item) => item.id === id);
    if (current?.status === 'paused') return;

    const message = err?.message || 'Download interrupted.';
    await updateDownloadState(id, { status: 'failed', error_message: message });
    notifyUI();

    await sendDownloadNotification('Download failed', `${title}: ${message}`, id);
  }
}

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
      activeTasks.delete(id);
    }
  }
}

export async function resumeDownload(item: DownloadItem): Promise<void> {
  if (!item.resolved_url) {
    return retryDownload(item);
  }

  await updateDownloadState(item.id, { status: 'downloading', error_message: null });
  notifyUI();

  await executeDownloadTask(
    item.id,
    item.resolved_url,
    item.filename,
    item.title,
    item.mode,
    item.resume_data
  );
}

export async function retryDownload(item: DownloadItem): Promise<void> {
  await updateDownloadState(item.id, {
    status: 'queued',
    progress: 0,
    resume_data: null,
    error_message: null,
  });
  notifyUI();

  try {
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

    await executeDownloadTask(
      item.id,
      resolved.streamUrl,
      item.filename,
      item.title,
      item.mode
    );
  } catch (err: any) {
    await updateDownloadState(item.id, {
      status: 'failed',
      error_message: err?.message || 'Retry failed.',
    });
    notifyUI();
  }
}

export async function saveItemToGallery(item: DownloadItem): Promise<void> {
  if (!item.local_uri) {
    throw new Error('File not found on device.');
  }

  const fileInfo = await FileSystem.getInfoAsync(item.local_uri);
  if (!fileInfo.exists) {
    throw new Error('Downloaded file no longer exists on disk.');
  }

  const { status } = await MediaLibrary.requestPermissionsAsync(true);
  if (status !== 'granted') {
    throw new Error('Gallery permission is required to save media.');
  }

  await MediaLibrary.createAssetAsync(item.local_uri);

  await updateDownloadState(item.id, { saved_to_gallery: 1 });
  notifyUI();
}

export async function shareDownloadedItem(item: DownloadItem): Promise<void> {
  if (!item.local_uri) {
    throw new Error('File not found on device.');
  }
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(item.local_uri, {
    dialogTitle: item.title,
  });
}

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

  if (item.thumbnail_uri) {
    try {
      await FileSystem.deleteAsync(item.thumbnail_uri, { idempotent: true });
    } catch {}
  }

  await deleteDownloadRecord(item.id);
  notifyUI();
}