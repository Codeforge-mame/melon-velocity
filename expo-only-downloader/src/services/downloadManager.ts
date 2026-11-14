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
  handleNotification: async (notification) => {
    const isProgressUpdate =
      notification.request.content.data?.progressUpdate === true;
    return {
      shouldShowAlert: !isProgressUpdate,
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: !isProgressUpdate,
      shouldShowList: true,
    };
  },
});

const activeTasks = new Map<string, FileSystem.DownloadResumable>();
const lastDbSync = new Map<string, number>();
const cancelledDownloads = new Set<string>();
const lastNotificationUpdate = new Map<string, { key: string; time: number }>();
const handledNotificationResponses = new Set<string>();
const notificationId = (id: string) => `dl-${id}`;
type DownloadNotificationState = Pick<
  DownloadItem,
  'id' | 'title' | 'status' | 'progress' | 'error_message'
>;

const notificationActions: Record<DownloadItem['status'], Notifications.NotificationAction[]> = {
  queued: [
    { identifier: 'delete', buttonTitle: 'Delete', options: { isDestructive: true } },
  ],
  downloading: [
    { identifier: 'pause', buttonTitle: 'Pause' },
    { identifier: 'delete', buttonTitle: 'Delete', options: { isDestructive: true } },
  ],
  paused: [
    { identifier: 'resume', buttonTitle: 'Resume' },
    { identifier: 'delete', buttonTitle: 'Delete', options: { isDestructive: true } },
  ],
  failed: [
    { identifier: 'retry', buttonTitle: 'Retry' },
    { identifier: 'delete', buttonTitle: 'Delete', options: { isDestructive: true } },
  ],
  completed: [
    { identifier: 'delete', buttonTitle: 'Delete', options: { isDestructive: true } },
  ],
};

let notificationCategoriesSetup: Promise<void> | undefined;
let notificationPermissionGranted = false;

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeDownloads(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyUI() {
  listeners.forEach((fn) => fn());
}

function registerNotificationCategories(): Promise<void> {
  if (!notificationCategoriesSetup) {
    notificationCategoriesSetup = Promise.all(
      Object.entries(notificationActions).map(([status, actions]) =>
        Notifications.setNotificationCategoryAsync(`download-${status}`, actions)
      )
    )
      .then(() => undefined)
      .catch((error: unknown) => {
        notificationCategoriesSetup = undefined;
        throw error;
      });
  }
  return notificationCategoriesSetup;
}

export async function ensureNotificationPermissions(): Promise<boolean> {
  await registerNotificationCategories();

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('rooster-downloads', {
      name: 'Rooster Downloads',
      importance: Notifications.AndroidImportance.LOW,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  if (existingStatus === 'granted') {
    notificationPermissionGranted = true;
    return true;
  }

  const { status } = await Notifications.requestPermissionsAsync();
  notificationPermissionGranted = status === 'granted';
  return notificationPermissionGranted;
}

async function updateDownloadNotification(
  item: DownloadNotificationState,
  force = false
): Promise<void> {
  if (!notificationPermissionGranted) return;

  const percent = Math.floor(Math.min(Math.max(item.progress || 0, 0), 1) * 100);
  const key = `${item.status}:${percent}:${item.error_message || ''}`;
  const id = notificationId(item.id);
  const now = Date.now();
  const previous = lastNotificationUpdate.get(item.id);

  if (previous?.key === key) return;
  if (
    !force &&
    item.status === 'downloading' &&
    previous &&
    now - previous.time < 2000
  ) {
    return;
  }

  const body =
    item.status === 'downloading'
      ? `Downloading · ${percent}%`
      : item.status === 'paused'
        ? `Paused · ${percent}%`
        : item.status === 'queued'
          ? 'Preparing download…'
          : item.status === 'completed'
            ? 'Download complete'
            : item.error_message || 'Download failed';

  await Notifications.dismissNotificationAsync(id);

  await Notifications.scheduleNotificationAsync({
    identifier: id,
    content: {
      title: item.title,
      body,
      sound: false,
      categoryIdentifier: `download-${item.status}`,
      sticky: item.status === 'downloading' || item.status === 'paused',
      data: {
        downloadId: item.id,
        progressUpdate: item.status === 'downloading',
      },
    },
    trigger:
      Platform.OS === 'android' ? { channelId: 'rooster-downloads' } : null,
  });

  lastNotificationUpdate.set(item.id, { key, time: now });
}

async function dismissDownloadNotification(id: string): Promise<void> {
  await Notifications.dismissNotificationAsync(notificationId(id));
  lastNotificationUpdate.delete(id);
}

async function handleDownloadNotificationResponse(
  response: Notifications.NotificationResponse
): Promise<void> {
  const action = response.actionIdentifier;
  if (!['pause', 'resume', 'retry', 'delete'].includes(action)) return;

  const key = `${response.notification.request.identifier}:${action}:${response.notification.date}`;
  if (handledNotificationResponses.has(key)) return;
  handledNotificationResponses.add(key);
  if (handledNotificationResponses.size > 100) {
    const oldestResponse = handledNotificationResponses.values().next().value;
    if (oldestResponse) handledNotificationResponses.delete(oldestResponse);
  }

  const downloadId = response.notification.request.content.data?.downloadId;
  if (typeof downloadId !== 'string') return;

  const item = (await getAllDownloads()).find((download) => download.id === downloadId);
  if (!item) {
    await dismissDownloadNotification(downloadId);
    return;
  }

  if (action === 'pause' && item.status === 'downloading') {
    await pauseDownload(item.id);
  } else if (action === 'resume' && item.status === 'paused') {
    await resumeDownload(item);
  } else if (action === 'retry' && item.status === 'failed') {
    await retryDownload(item);
  } else if (action === 'delete') {
    await removeDownload(item);
  }
}

export async function registerDownloadNotificationActions(): Promise<{
  remove: () => void;
}> {
  await registerNotificationCategories();
  const { status } = await Notifications.getPermissionsAsync();
  notificationPermissionGranted = status === 'granted';
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    void handleDownloadNotificationResponse(response).catch((error: unknown) => {
      console.error('Failed to handle download notification action.', error);
    });
  });

  try {
    const lastResponse = Notifications.getLastNotificationResponse();
    if (lastResponse) {
      await handleDownloadNotificationResponse(lastResponse);
      Notifications.clearLastNotificationResponse();
    }
  } catch (error) {
    subscription.remove();
    throw error;
  }

  return subscription;
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
  await updateDownloadNotification({
    id,
    title: 'Preparing download',
    status: 'queued',
    progress: 0,
    error_message: null,
  }, true);

  try {
    const resolved = await resolveMediaUrl({ url: sourceUrl, mode, quality });
    if (cancelledDownloads.has(id)) {
      cancelledDownloads.delete(id);
      return id;
    }

    const db = await import('../db/database').then((m) => m.getDB());
    await db.runAsync(
      'UPDATE downloads SET title = ?, filename = ?, resolved_url = ?, status = ? WHERE id = ?',
      [resolved.title, resolved.filename, resolved.streamUrl, 'downloading', id]
    );
    if (cancelledDownloads.has(id)) {
      cancelledDownloads.delete(id);
      return id;
    }
    notifyUI();

    await updateDownloadNotification({
      id,
      title: resolved.title,
      status: 'downloading',
      progress: 0,
      error_message: null,
    }, true);
    if (cancelledDownloads.has(id)) {
      cancelledDownloads.delete(id);
      return id;
    }
    await executeDownloadTask(id, resolved.streamUrl, resolved.filename, resolved.title, mode);
    return id;
  } catch (err: any) {
    if (cancelledDownloads.has(id)) {
      cancelledDownloads.delete(id);
      return id;
    }
    const message = err?.message || 'Failed to resolve media link.';
    await updateDownloadState(id, { status: 'failed', error_message: message });
    notifyUI();
    const failedItem = (await getAllDownloads()).find((item) => item.id === id);
    if (failedItem) await updateDownloadNotification(failedItem, true);
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
      try {
        await updateDownloadNotification({
          id,
          title,
          status: 'downloading',
          progress: ratio,
          error_message: null,
        });
      } catch (error) {
        console.error('Failed to update download progress notification.', error);
      }
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

    if (cancelledDownloads.has(id)) return;
    if (!result) return;
    if (result.status >= 400) {
      throw new Error(`Server returned HTTP ${result.status}`);
    }

    const thumbnailUri =
      mode !== 'audio' ? await generateAndSaveThumbnail(id, result.uri) : null;
    if (cancelledDownloads.has(id)) return;

    await updateDownloadState(id, {
      status: 'completed',
      progress: 1,
      local_uri: result.uri,
      thumbnail_uri: thumbnailUri,
      resume_data: null,
      error_message: null,
    });
    notifyUI();

    const completedItem = (await getAllDownloads()).find((item) => item.id === id);
    if (completedItem) await updateDownloadNotification(completedItem, true);
  } catch (err: any) {
    activeTasks.delete(id);
    lastDbSync.delete(id);

    if (cancelledDownloads.has(id)) return;
    const currentItems = await getAllDownloads();
    const current = currentItems.find((item) => item.id === id);
    if (current?.status === 'paused') return;

    const message = err?.message || 'Download interrupted.';
    await updateDownloadState(id, { status: 'failed', error_message: message });
    notifyUI();

    const failedItem = (await getAllDownloads()).find((item) => item.id === id);
    if (failedItem) await updateDownloadNotification(failedItem, true);
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

  const pausedItem = (await getAllDownloads()).find((item) => item.id === id);
  if (pausedItem) await updateDownloadNotification(pausedItem, true);
}

export async function resumeDownload(item: DownloadItem): Promise<void> {
  if (!item.resolved_url) {
    return retryDownload(item);
  }

  await updateDownloadState(item.id, { status: 'downloading', error_message: null });
  if (cancelledDownloads.has(item.id)) {
    cancelledDownloads.delete(item.id);
    return;
  }
  notifyUI();
  await updateDownloadNotification({ ...item, status: 'downloading' }, true);
  if (cancelledDownloads.has(item.id)) {
    cancelledDownloads.delete(item.id);
    return;
  }

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
  await updateDownloadNotification({ ...item, status: 'queued', progress: 0 }, true);

  try {
    const resolved = await resolveMediaUrl({
      url: item.source_url,
      mode: item.mode,
      quality: item.quality as VideoQuality,
    });
    if (cancelledDownloads.has(item.id)) {
      cancelledDownloads.delete(item.id);
      return;
    }

    await updateDownloadState(item.id, {
      status: 'downloading',
      resolved_url: resolved.streamUrl,
    });
    if (cancelledDownloads.has(item.id)) {
      cancelledDownloads.delete(item.id);
      return;
    }
    notifyUI();
    await updateDownloadNotification({
      ...item,
      title: resolved.title,
      status: 'downloading',
      progress: 0,
    }, true);
    if (cancelledDownloads.has(item.id)) {
      cancelledDownloads.delete(item.id);
      return;
    }

    await executeDownloadTask(
      item.id,
      resolved.streamUrl,
      item.filename,
      resolved.title,
      item.mode
    );
  } catch (err: any) {
    if (cancelledDownloads.has(item.id)) {
      cancelledDownloads.delete(item.id);
      return;
    }
    await updateDownloadState(item.id, {
      status: 'failed',
      error_message: err?.message || 'Retry failed.',
    });
    notifyUI();
    const failedItem = (await getAllDownloads()).find((download) => download.id === item.id);
    if (failedItem) await updateDownloadNotification(failedItem, true);
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
  if (item.status === 'queued' || item.status === 'downloading' || item.status === 'paused') {
    cancelledDownloads.add(item.id);
  }

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
  await dismissDownloadNotification(item.id);
  notifyUI();

  if (task) cancelledDownloads.delete(item.id);
}