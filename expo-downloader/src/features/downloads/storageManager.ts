import * as FileSystem from 'expo-file-system';
import { getDatabase } from '../../db/database';

export type StorageInfo = {
  totalSpace: number;
  freeSpace: number;
  usedSpace: number;
  downloadsSize: number;
  downloadsCount: number;
  videosSize: number;
  videosCount: number;
};

export async function getStorageInfo(): Promise<StorageInfo> {
  const db = await getDatabase();
  
  // Get total downloads info
  const downloads = await db.getAllAsync<any>(
    'SELECT file_uri, file_size FROM downloads WHERE file_uri IS NOT NULL'
  );
  
  let downloadsSize = 0;
  const downloadsCount = downloads.length;
  
  for (const download of downloads) {
    if (download.file_size) {
      downloadsSize += download.file_size;
    } else {
      try {
        const fileInfo = await FileSystem.getInfoAsync(download.file_uri);
        if (fileInfo.exists && fileInfo.size) {
          downloadsSize += fileInfo.size;
        }
      } catch (error) {
        console.warn('Failed to get file size:', error);
      }
    }
  }
  
  // Get videos saved to gallery
  const videos = await db.getAllAsync<any>(
    'SELECT gallery_saved FROM downloads WHERE gallery_saved = 1'
  );
  const videosCount = videos.length;
  
  // Estimate videos size (same as downloads since they're the same files)
  const videosSize = downloadsSize;
  
  // Get device storage info
  const freeSpace = await FileSystem.getFreeDiskStorageAsync();
  const totalSpace = freeSpace + downloadsSize; // Approximation
  const usedSpace = downloadsSize;
  
  return {
    totalSpace,
    freeSpace,
    usedSpace,
    downloadsSize,
    downloadsCount,
    videosSize,
    videosCount,
  };
}

export async function clearOldDownloads(olderThanDays: number = 30): Promise<number> {
  const db = await getDatabase();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
  
  const result = await db.getAllAsync<any>(
    `SELECT id, file_uri FROM downloads 
     WHERE completed_at < ? AND file_uri IS NOT NULL AND gallery_saved = 0`,
    cutoffDate.toISOString()
  );
  
  let deletedCount = 0;
  
  for (const row of result) {
    try {
      if (row.file_uri) {
        await FileSystem.deleteAsync(row.file_uri);
      }
      await db.runAsync('DELETE FROM downloads WHERE id = ?', row.id);
      deletedCount++;
    } catch (error) {
      console.warn('Failed to delete old download:', error);
    }
  }
  
  return deletedCount;
}

export async function clearFailedDownloads(): Promise<number> {
  const db = await getDatabase();
  
  const result = await db.getAllAsync<any>(
    'SELECT id, file_uri FROM downloads WHERE status = ? AND file_uri IS NOT NULL',
    'failed'
  );
  
  let deletedCount = 0;
  
  for (const row of result) {
    try {
      if (row.file_uri) {
        await FileSystem.deleteAsync(row.file_uri);
      }
      await db.runAsync('DELETE FROM downloads WHERE id = ?', row.id);
      deletedCount++;
    } catch (error) {
      console.warn('Failed to delete failed download:', error);
    }
  }
  
  return deletedCount;
}

export async function clearCompletedDownloads(): Promise<number> {
  const db = await getDatabase();
  
  const result = await db.getAllAsync<any>(
    'SELECT id, file_uri FROM downloads WHERE status = ? AND file_uri IS NOT NULL AND gallery_saved = 0',
    'completed'
  );
  
  let deletedCount = 0;
  
  for (const row of result) {
    try {
      if (row.file_uri) {
        await FileSystem.deleteAsync(row.file_uri);
      }
      await db.runAsync('DELETE FROM downloads WHERE id = ?', row.id);
      deletedCount++;
    } catch (error) {
      console.warn('Failed to delete completed download:', error);
    }
  }
  
  return deletedCount;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
