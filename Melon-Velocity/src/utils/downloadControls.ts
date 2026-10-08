export interface ActiveDownloadControls {
  pause?: () => Promise<void>;
  cancel?: () => Promise<void>;
}

const activeDownloads = new Map<number, ActiveDownloadControls>();
const cancelledDownloads = new Set<number>();

export function registerDownloadControls(
  recordId: number,
  controls: ActiveDownloadControls,
): () => void {
  activeDownloads.set(recordId, controls);
  return () => {
    if (activeDownloads.get(recordId) === controls) activeDownloads.delete(recordId);
  };
}

export async function pauseActiveDownload(recordId: number): Promise<boolean> {
  const pause = activeDownloads.get(recordId)?.pause;
  if (!pause) return false;
  await pause();
  return true;
}

export async function cancelActiveDownload(recordId: number): Promise<boolean> {
  const controls = activeDownloads.get(recordId);
  if (!controls?.cancel) return false;
  cancelledDownloads.add(recordId);
  await controls.cancel();
  return true;
}

export function isDownloadCancelled(recordId: number): boolean {
  return cancelledDownloads.has(recordId);
}

export function markDownloadCancelled(recordId: number): void {
  cancelledDownloads.add(recordId);
}

export function clearDownloadCancellation(recordId: number): void {
  cancelledDownloads.delete(recordId);
}
