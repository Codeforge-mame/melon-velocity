import * as SQLite from 'expo-sqlite';

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed';
export type DownloadMode = 'auto' | 'audio' | 'mute'; // auto = Audio+Video, mute = Video Only

export interface DownloadItem {
  id: string;
  source_url: string;
  resolved_url: string | null;
  title: string;
  filename: string;
  mode: DownloadMode;
  quality: string;
  status: DownloadStatus;
  progress: number;
  resume_data: string | null;
  local_uri: string | null;
  saved_to_gallery: number; // 0 or 1
  error_message: string | null;
  created_at: number;
}

let dbInstance: SQLite.SQLiteDatabase | null = null;

export async function getDB(): Promise<SQLite.SQLiteDatabase> {
  if (!dbInstance) {
    dbInstance = await SQLite.openDatabaseAsync('cobalt_downloads.db');
    await initDB(dbInstance);
  }
  return dbInstance;
}

async function initDB(db: SQLite.SQLiteDatabase) {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY NOT NULL,
      source_url TEXT NOT NULL,
      resolved_url TEXT,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      mode TEXT NOT NULL,
      quality TEXT NOT NULL,
      status TEXT NOT NULL,
      progress REAL DEFAULT 0,
      resume_data TEXT,
      local_uri TEXT,
      saved_to_gallery INTEGER DEFAULT 0,
      error_message TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

// Create a new download record
export async function insertDownload(item: Omit<DownloadItem, 'created_at'>): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    `INSERT INTO downloads (
      id, source_url, resolved_url, title, filename, mode, quality, 
      status, progress, resume_data, local_uri, saved_to_gallery, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.id,
      item.source_url,
      item.resolved_url,
      item.title,
      item.filename,
      item.mode,
      item.quality,
      item.status,
      item.progress,
      item.resume_data,
      item.local_uri,
      item.saved_to_gallery,
      item.error_message,
      Date.now(),
    ]
  );
}

// Fetch all downloads for the History & Active Queue screens
export async function getAllDownloads(): Promise<DownloadItem[]> {
  const db = await getDB();
  return await db.getAllAsync<DownloadItem>(
    'SELECT * FROM downloads ORDER BY created_at DESC'
  );
}

// Update status, progress, or resume snapshot
export async function updateDownloadState(
  id: string,
  updates: Partial<
    Pick<
      DownloadItem,
      'status' | 'progress' | 'resume_data' | 'local_uri' | 'resolved_url' | 'saved_to_gallery' | 'error_message'
    >
  >
): Promise<void> {
  const db = await getDB();
  const keys = Object.keys(updates) as (keyof typeof updates)[];
  if (keys.length === 0) return;

  const setClause = keys.map((key) => `${key} = ?`).join(', ');
  const values = keys.map((key) => updates[key] ?? null);

  await db.runAsync(`UPDATE downloads SET ${setClause} WHERE id = ?`, [...values, id]);
}

// Delete a download record
export async function deleteDownloadRecord(id: string): Promise<void> {
  const db = await getDB();
  await db.runAsync('DELETE FROM downloads WHERE id = ?', [id]);
}