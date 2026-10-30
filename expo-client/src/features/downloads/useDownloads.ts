import { useEffect, useSyncExternalStore } from "react";

import {
  bindDownloadLifecycle,
  getDownloads,
  hydrateDownloads,
  subscribeDownloads,
} from "./downloadManager";
import type { DownloadRecord } from "./types";

export function useDownloads(): DownloadRecord[] {
  useEffect(() => {
    bindDownloadLifecycle();
    void hydrateDownloads();
  }, []);

  return useSyncExternalStore(subscribeDownloads, getDownloads, getDownloads);
}
