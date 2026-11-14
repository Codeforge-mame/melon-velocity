import { useEffect, useSyncExternalStore } from "react";

import {
  getDownloads,
  hydrateDownloads,
  subscribeDownloads,
} from "./downloadManager";
import type { DownloadRecord } from "./types";

export function useDownloads(): DownloadRecord[] {
  useEffect(() => {
    void hydrateDownloads();
  }, []);

  return useSyncExternalStore(subscribeDownloads, getDownloads, getDownloads);
}
