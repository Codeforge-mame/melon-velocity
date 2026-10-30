import * as SQLite from "expo-sqlite";

import type { DownloadRecord, DownloadStatus } from "@/features/downloads/types";

const DB_NAME = "mvelocity.db";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function init(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      thumbnailUrl TEXT,
      filename TEXT NOT NULL,
      url TEXT NOT NULL,
      formatId TEXT NOT NULL,
      resolutionLabel TEXT NOT NULL,
      status TEXT NOT NULL,
      bytesWritten INTEGER NOT NULL DEFAULT 0,
      totalBytes INTEGER NOT NULL DEFAULT 0,
      localUri TEXT,
      error TEXT,
      resumeData TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_downloads_createdAt
      ON downloads (createdAt DESC);
  `);
  return db;
}

export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = init();
  return dbPromise;
}

type DownloadRow = {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  filename: string;
  url: string;
  formatId: string;
  resolutionLabel: string;
  status: string;
  bytesWritten: number;
  totalBytes: number;
  localUri: string | null;
  error: string | null;
  resumeData: string | null;
  createdAt: number;
};

function toRecord(row: DownloadRow): DownloadRecord {
  return {
    id: row.id,
    title: row.title,
    thumbnailUrl: row.thumbnailUrl,
    filename: row.filename,
    url: row.url,
    formatId: row.formatId,
    resolutionLabel: row.resolutionLabel,
    status: row.status as DownloadStatus,
    bytesWritten: row.bytesWritten,
    totalBytes: row.totalBytes,
    localUri: row.localUri,
    error: row.error,
    resumeData: row.resumeData,
    createdAt: row.createdAt,
  };
}

export async function insertDownload(record: DownloadRecord): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT OR REPLACE INTO downloads
      (id, title, thumbnailUrl, filename, url, formatId, resolutionLabel, status,
       bytesWritten, totalBytes, localUri, error, resumeData, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.title,
      record.thumbnailUrl ?? null,
      record.filename,
      record.url,
      record.formatId,
      record.resolutionLabel,
      record.status,
      record.bytesWritten,
      record.totalBytes,
      record.localUri ?? null,
      record.error ?? null,
      record.resumeData ?? null,
      record.createdAt,
    ],
  );
}

const UPDATABLE: (keyof DownloadRecord)[] = [
  "status",
  "bytesWritten",
  "totalBytes",
  "localUri",
  "error",
  "resumeData",
];

export async function updateDownload(
  id: string,
  patch: Partial<DownloadRecord>,
): Promise<void> {
  const keys = UPDATABLE.filter((key) => patch[key] !== undefined);
  if (keys.length === 0) return;

  const db = await getDatabase();
  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  const values = keys.map((key) => {
    const value = patch[key];
    return typeof value === "undefined" ? null : value;
  });
  await db.runAsync(
    `UPDATE downloads SET ${assignments} WHERE id = ?`,
    [...values, id] as SQLite.SQLiteBindValue[],
  );
}

export async function getAllDownloads(): Promise<DownloadRecord[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<DownloadRow>(
    "SELECT * FROM downloads ORDER BY createdAt DESC",
  );
  return rows.map(toRecord);
}

export async function deleteDownload(id: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync("DELETE FROM downloads WHERE id = ?", [id]);
}

export async function deleteCompletedDownloads(): Promise<void> {
  const db = await getDatabase();
  await db.runAsync("DELETE FROM downloads WHERE status = 'completed'");
}
