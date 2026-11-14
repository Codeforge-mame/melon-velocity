import { Directory, DownloadTask, File, Paths } from "expo-file-system";
import type { DownloadPauseState } from "expo-file-system";
import * as MediaLibrary from "expo-media-library";

import { refreshVideo } from "@/api/client";
import {
  deleteCompletedDownloads,
  deleteDownload as dbDeleteDownload,
  getAllDownloads,
  insertDownload,
  updateDownload,
} from "@/db/database";

import type { DownloadRecord, DownloadStatus } from "./types";

const MAX_CONCURRENT = 2;
const PROGRESS_PERSIST_INTERVAL = 1500;
const MAX_RERESOLVE_ATTEMPTS = 2;
const MAX_BACKOFF_ATTEMPTS = 3;
const BACKOFF_DELAYS_MS = [2000, 4000, 8000];

type Listener = () => void;

let records: DownloadRecord[] = [];
let hydrated = false;
const listeners = new Set<Listener>();

const queue: string[] = [];
const active = new Map<string, DownloadTask>();
const lastPersist = new Map<string, number>();
const reResolveAttempts = new Map<string, number>();
const backoffAttempts = new Map<string, number>();

function find(id: string): DownloadRecord | undefined {
  return records.find((r) => r.id === id);
}

function setRecords(next: DownloadRecord[]) {
  records = next;
  for (const listener of listeners) listener();
}

function emit() {
  for (const listener of listeners) listener();
}

function sortRecords(next: DownloadRecord[]): DownloadRecord[] {
  return [...next].sort((a, b) => b.createdAt - a.createdAt);
}

async function patch(
  id: string,
  changes: Partial<DownloadRecord>,
  persist = true,
): Promise<void> {
  records = records.map((r) => (r.id === id ? { ...r, ...changes } : r));
  emit();
  if (persist) {
    await updateDownload(id, changes);
  }
}

function resetAttempts(id: string) {
  reResolveAttempts.delete(id);
  backoffAttempts.delete(id);
}

export function getDownloads(): DownloadRecord[] {
  return records;
}

export function subscribeDownloads(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Load persisted downloads. Any row left mid-flight by a previous session can
 * only be resumed when the file reached its destination; otherwise it becomes
 * a restartable paused entry.
 */
export async function hydrateDownloads(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  const rows = await getAllDownloads();
  const reconciled = rows.map((row) => {
    if (row.status === "downloading" || row.status === "queued") {
      const destination = destinationFor(row);
      const finished = destination.exists && (destination.size ?? 0) > 0;
      if (finished) {
        return { ...row, status: "completed" as DownloadStatus, error: null };
      }
      return { ...row, status: "paused" as DownloadStatus, error: null };
    }
    return row;
  });

  setRecords(sortRecords(reconciled));

  for (let i = 0; i < rows.length; i++) {
    if (rows[i].status !== reconciled[i].status) {
      await updateDownload(reconciled[i].id, { status: reconciled[i].status });
    }
  }
  pump();
}

function destinationFor(record: DownloadRecord): File {
  const downloadDir = new Directory(Paths.cache, "downloads");
  if (!downloadDir.exists) downloadDir.create({ intermediates: true });
  const safeName = record.filename
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return new File(downloadDir, `${record.id}-${safeName}`);
}

function parseHeaders(record: DownloadRecord): Record<string, string> {
  if (!record.httpHeaders) return {};
  try {
    const parsed = JSON.parse(record.httpHeaders);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function makeTask(record: DownloadRecord): DownloadTask {
  return new DownloadTask(record.url, destinationFor(record), {
    sessionType: "background",
    headers: parseHeaders(record),
    onProgress: ({ bytesWritten, totalBytes }) => {
      void handleProgress(record.id, bytesWritten, totalBytes);
    },
  });
}

async function handleProgress(
  id: string,
  bytesWritten: number,
  totalBytes: number,
): Promise<void> {
  const now = Date.now();
  const last = lastPersist.get(id) ?? 0;
  const shouldPersist = now - last >= PROGRESS_PERSIST_INTERVAL;
  if (shouldPersist) lastPersist.set(id, now);
  await patch(id, { bytesWritten, totalBytes }, shouldPersist);
}

export async function saveFileToGallery(fileUri: string): Promise<boolean> {
  try {
    const { granted } = await MediaLibrary.requestPermissionsAsync();
    if (!granted) return false;
    await MediaLibrary.Asset.create(fileUri);
    return true;
  } catch {
    return false;
  }
}

async function saveToLibrary(file: File): Promise<string> {
  const saved = await saveFileToGallery(file.uri);
  if (!saved) return file.uri;
  return file.uri;
}

/**
 * Manually save an already-downloaded item to the device gallery.
 */
export async function saveDownloadToGallery(id: string): Promise<boolean> {
  const record = find(id);
  if (!record?.localUri) return false;
  return saveFileToGallery(record.localUri);
}

async function finalize(id: string, file: File): Promise<void> {
  const localUri = await saveToLibrary(file);
  lastPersist.delete(id);
  resetAttempts(id);
  await patch(id, {
    status: "completed",
    localUri,
    bytesWritten: file.size ?? find(id)?.bytesWritten ?? 0,
    totalBytes: file.size ?? find(id)?.totalBytes ?? 0,
    resumeData: null,
    error: null,
  });
}

async function fail(id: string, error: unknown): Promise<void> {
  const record = find(id);
  if (record?.status === "paused") return;
  await patch(id, {
    status: "error",
    error: error instanceof Error ? error.message : "Download failed",
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpStatusFromError(error: unknown): number | null {
  const match = /HTTP\s+(\d{3})/.exec(errorMessage(error));
  return match ? parseInt(match[1], 10) : null;
}

function isNetworkError(error: unknown): boolean {
  const msg = errorMessage(error).toLowerCase();
  return (
    msg.includes("no address associated with hostname") ||
    msg.includes("getaddrinfo") ||
    msg.includes("enotfound") ||
    msg.includes("nodename nor servname") ||
    msg.includes("network is unreachable") ||
    msg.includes("connection reset") ||
    msg.includes("timed out")
  );
}

/**
 * Fetch a fresh download URL + headers for a record whose stored URL has
 * expired (403/404). Returns true when a matching format was refreshed.
 */
async function refreshRecordUrl(id: string): Promise<boolean> {
  const record = find(id);
  if (!record?.sourceUrl) return false;

  try {
    const fresh = await refreshVideo(record.sourceUrl);
    const match =
      fresh.formats.find((f) => f.formatId === record.formatId) ??
      fresh.formats.find((f) => f.label === record.resolutionLabel);

    if (!match?.downloadUrl) return false;

    await patch(id, {
      url: match.downloadUrl,
      httpHeaders: JSON.stringify(match.httpHeaders ?? {}),
      error: null,
    });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RetryAction =
  | { kind: "reresolve" }
  | { kind: "backoff"; delay: number }
  | { kind: "fail" };

function planRetry(id: string, error: unknown): RetryAction {
  const status = httpStatusFromError(error);

  if (status === 403 || status === 404) {
    const attempts = reResolveAttempts.get(id) ?? 0;
    if (attempts < MAX_RERESOLVE_ATTEMPTS) {
      reResolveAttempts.set(id, attempts + 1);
      return { kind: "reresolve" };
    }
    return { kind: "fail" };
  }

  if (isNetworkError(error)) {
    const attempts = backoffAttempts.get(id) ?? 0;
    if (attempts < MAX_BACKOFF_ATTEMPTS) {
      backoffAttempts.set(id, attempts + 1);
      return { kind: "backoff", delay: BACKOFF_DELAYS_MS[attempts] ?? 8000 };
    }
    return { kind: "fail" };
  }

  return { kind: "fail" };
}

async function execute(
  id: string,
  initialTask: DownloadTask,
  mode: "start" | "resume",
): Promise<void> {
  let task = initialTask;
  let currentMode = mode;
  active.set(id, task);
  await patch(id, { status: "downloading", error: null });

  try {
    for (;;) {
      try {
        const file =
          currentMode === "resume"
            ? await task.resumeAsync()
            : await task.downloadAsync();

        if (file) {
          await finalize(id, file);
        } else {
          await fail(id, new Error("Download interrupted"));
        }
        return;
      } catch (error) {
        const action = planRetry(id, error);

        if (action.kind === "reresolve") {
          const refreshed = await refreshRecordUrl(id);
          if (!refreshed) {
            await fail(id, error);
            return;
          }
          task.release();
          const record = find(id);
          if (!record) {
            await fail(id, error);
            return;
          }
          task = makeTask(record);
          active.set(id, task);
          currentMode = "start";
          await patch(id, { status: "downloading", error: null });
          continue;
        }

        if (action.kind === "backoff") {
          await sleep(action.delay);
          const record = find(id);
          if (!record) {
            await fail(id, error);
            return;
          }
          task.release();
          task = makeTask(record);
          active.set(id, task);
          currentMode = "start";
          await patch(id, { status: "downloading", error: null });
          continue;
        }

        await fail(id, error);
        return;
      }
    }
  } finally {
    active.delete(id);
    task.release();
    pump();
  }
}

function pump(): void {
  while (active.size < MAX_CONCURRENT && queue.length > 0) {
    const id = queue.shift()!;
    const record = find(id);
    if (!record) continue;
    void execute(id, makeTask(record), "start");
  }
}

export type StartDownloadInput = {
  id?: string;
  url: string;
  title: string;
  thumbnailUrl?: string | null;
  filename: string;
  formatId: string;
  resolutionLabel: string;
  sourceUrl?: string;
  httpHeaders?: Record<string, string>;
};

function generateId(): string {
  return `download-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function startDownload(input: StartDownloadInput): Promise<void> {
  const record: DownloadRecord = {
    id: input.id ?? generateId(),
    title: input.title,
    thumbnailUrl: input.thumbnailUrl ?? null,
    filename: input.filename,
    url: input.url,
    formatId: input.formatId,
    resolutionLabel: input.resolutionLabel,
    status: "queued",
    bytesWritten: 0,
    totalBytes: 0,
    localUri: null,
    error: null,
    resumeData: null,
    sourceUrl: input.sourceUrl ?? null,
    httpHeaders: input.httpHeaders
      ? JSON.stringify(input.httpHeaders)
      : null,
    createdAt: Date.now(),
  };

  resetAttempts(record.id);
  setRecords(sortRecords([record, ...records]));
  await insertDownload(record);
  queue.push(record.id);
  pump();
}

export async function pauseDownload(id: string): Promise<void> {
  const record = find(id);
  if (!record) return;

  const task = active.get(id);
  if (!task) {
    if (record.status === "queued" || record.status === "downloading") {
      const index = queue.indexOf(id);
      if (index >= 0) queue.splice(index, 1);
      await patch(id, { status: "paused" });
    }
    return;
  }

  try {
    await task.pauseAsync();
    const state = task.savable();
    await patch(id, {
      status: "paused",
      resumeData: JSON.stringify(state),
    });
  } catch {
    await patch(id, { status: "paused" });
  }
}

export async function resumeDownload(id: string): Promise<void> {
  const record = find(id);
  if (!record) return;
  if (record.status !== "paused" && record.status !== "error") return;

  resetAttempts(id);

  if (record.resumeData) {
    try {
      const state = JSON.parse(record.resumeData) as DownloadPauseState;
      const task = DownloadTask.fromSavable(state, {
        sessionType: "background",
        onProgress: ({ bytesWritten, totalBytes }) => {
          void handleProgress(id, bytesWritten, totalBytes);
        },
      });
      await execute(id, task, "resume");
      return;
    } catch {
      // fall through to a fresh restart below
    }
  }

  queue.push(id);
  await patch(id, { status: "queued", error: null, resumeData: null });
  pump();
}

export async function cancelDownload(id: string): Promise<void> {
  const task = active.get(id);
  if (task) {
    task.cancel();
    active.delete(id);
    task.release();
  }
  const index = queue.indexOf(id);
  if (index >= 0) queue.splice(index, 1);
}

export async function removeDownload(id: string): Promise<void> {
  await cancelDownload(id);
  setRecords(records.filter((r) => r.id !== id));
  resetAttempts(id);
  await dbDeleteDownload(id);
  pump();
}

export async function clearCompleted(): Promise<void> {
  setRecords(records.filter((r) => r.status !== "completed"));
  await deleteCompletedDownloads();
}
