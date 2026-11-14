import { useEffect, useState, useCallback } from 'react';
import { DownloadItem, getAllDownloads } from '../db/database';
import { subscribeDownloads } from '../services/downloadManager';

export function useDownloads() {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const items = await getAllDownloads();
      setDownloads(items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const unsubscribe = subscribeDownloads(() => {
      refresh();
    });
    return unsubscribe;
  }, [refresh]);

  return { downloads, loading, refresh };
}