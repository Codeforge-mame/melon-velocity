import { AppState } from "react-native";
import type { AppStateStatus } from "react-native";
import { Directory, File, Paths, DownloadTask } from "expo-file-system";
import type { DownloadPauseState } from "expo-file-system";
import * as MediaLibrary from "expo-media-library";

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

type Listener = () => void;

let records: DownloadRecord[] = [];
let hydrated = false;
const listeners = new Set<Listener>();

const queue: string[] = [];
const active = new Map<string, DownloadTask>();
const lastPersist = new Map<string, number>();

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

export function getDownloads(): DownloadRecord[] {
  return records;
}

export function subscribeDownloads(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Load persisted downloads and reconcile any in-flight rows from a previous
 * session. Rows that were mid-download can only be resumed when resume data
 * was saved; otherwise they restart from scratch on resume.
 */
export async function hydrateDownloads(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  const rows = await getAllDownloads();
  const reconciled = rows.map((row) => {
    if (
      row.status === "downloading" ||
      row.status === "queued"
    ) {
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

function makeTask(record: DownloadRecord): DownloadTask {
  return new DownloadTask(record.url, destinationFor(record), {
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

async function saveToLibrary(file: File): Promise<string> {
  try {
    const { granted } = await MediaLibrary.requestPermissionsAsync();
    if (!granted) return file.uri;
    const asset = await MediaLibrary.Asset.create(file.uri);
    return (await asset.getUri()) ?? file.uri;
  } catch {
    return file.uri;
  }
}

async function finalize(id: string, file: File): Promise<void> {
  const localUri = await saveToLibrary(file);
  lastPersist.delete(id);
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

async function execute(
  id: string,
  task: DownloadTask,
  mode: "start" | "resume",
): Promise<void> {
  active.set(id, task);
  await patch(id, { status: "downloading", error: null });

  try {
    const file =
      mode === "resume" ? await task.resumeAsync() : await task.downloadAsync();
    if (file) {
      await finalize(id, file);
    } else {
      await fail(id, new Error("Download interrupted"));
    }
  } catch (error) {
    await fail(id, error);
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
  id: string;
  url: string;
  title: string;
  thumbnailUrl?: string | null;
  filename: string;
  formatId: string;
  resolutionLabel: string;
};

export async function startDownload(input: StartDownloadInput): Promise<void> {
  const record: DownloadRecord = {
    id: input.id,
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
    createdAt: Date.now(),
  };

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

  if (record.resumeData) {
    try {
      const state = JSON.parse(record.resumeData) as DownloadPauseState;
      const task = DownloadTask.fromSavable(state, {
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
  await dbDeleteDownload(id);
  pump();
}

export async function clearCompleted(): Promise<void> {
  setRecords(records.filter((r) => r.status !== "completed"));
  await deleteCompletedDownloads();
}

let appStateBound = false;

/**
 * Bind a global AppState listener so active downloads are paused (and their
 * resume state persisted) when the app is backgrounded.
 */
export function bindDownloadLifecycle(): void {
  if (appStateBound) return;
  appStateBound = true;
  AppState.addEventListener("change", (state: AppStateStatus) => {
    if (state !== "active") {
      for (const id of active.keys()) {
        void pauseDownload(id);
      }
    }
  });
}
