import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

export type NotificationType = 'download_started' | 'download_progress' | 'download_completed' | 'download_failed' | 'download_paused';

export type NotificationData = {
  type: NotificationType;
  downloadId: string;
  title: string;
  message: string;
  progress?: number;
  error?: string;
};

class NotificationManager {
  private enabled = false;
  private permissionGranted = false;

  async initialize(): Promise<void> {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('downloads', {
        name: 'Downloads',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
      });
    }

    const { granted: alreadyGranted } = await Notifications.getPermissionsAsync();

    if (alreadyGranted) {
      this.permissionGranted = true;
    } else {
      const { granted } = await Notifications.requestPermissionsAsync();
      this.permissionGranted = granted;
    }

    this.enabled = this.permissionGranted;
  }

  async showNotification(data: NotificationData): Promise<void> {
    if (!this.enabled || !this.permissionGranted) {
      return;
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: data.title,
        body: data.message,
        data: {
          downloadId: data.downloadId,
          type: data.type,
        },
        sound: true,
      },
      trigger: null,
    });
  }

  async showDownloadStarted(downloadId: string, title: string): Promise<void> {
    await this.showNotification({
      type: 'download_started',
      downloadId,
      title: 'Download Started',
      message: `Downloading: ${title}`,
    });
  }

  async showDownloadProgress(downloadId: string, title: string, progress: number): Promise<void> {
    // Only show progress notifications at milestones (25%, 50%, 75%, 100%)
    if (progress % 25 !== 0 && progress !== 100) {
      return;
    }

    await this.showNotification({
      type: 'download_progress',
      downloadId,
      title: 'Download Progress',
      message: `${title}: ${progress}% complete`,
      progress,
    });
  }

  async showDownloadCompleted(downloadId: string, title: string): Promise<void> {
    await this.showNotification({
      type: 'download_completed',
      downloadId,
      title: 'Download Complete',
      message: `${title} has been downloaded successfully`,
    });
  }

  async showDownloadFailed(downloadId: string, title: string, error: string): Promise<void> {
    await this.showNotification({
      type: 'download_failed',
      downloadId,
      title: 'Download Failed',
      message: `${title} failed: ${error}`,
      error,
    });
  }

  async showDownloadPaused(downloadId: string, title: string): Promise<void> {
    await this.showNotification({
      type: 'download_paused',
      downloadId,
      title: 'Download Paused',
      message: `${title} has been paused`,
    });
  }

  async cancelNotification(downloadId: string): Promise<void> {
    await Notifications.cancelAllScheduledNotificationsAsync();
  }

  async cancelAllNotifications(): Promise<void> {
    await Notifications.cancelAllScheduledNotificationsAsync();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isPermissionGranted(): boolean {
    return this.permissionGranted;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled && this.permissionGranted;
  }
}

export const notificationManager = new NotificationManager();
