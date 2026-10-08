import { SQLiteProvider, useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import React, { createContext, useContext } from 'react';

export interface DownloadRecord {
    id: number;
    title: string;
    url: string;
    localPath: string;
    fileSize: number;
    resolution: string;
    thumbnail: string;
    downloadedAt: string;
    mediaAssetId: string | null;
    cancelToken: string | null;
    resumeSnapshot: string | null;
    mode: 'default' | 'youtube' | 'tiktok' | 'telegram';
    formatId: string;
    serverBoost: number;
    status: DownloadStatus;
    progress: number;
    taskId: string | null;
    error: string | null;
}

export type DownloadStatus = 'queued' | 'processing' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type DownloadUpdate = Partial<Pick<
    DownloadRecord,
    'status' | 'progress' | 'taskId' | 'localPath' | 'fileSize' | 'mediaAssetId' |
    'cancelToken' | 'resumeSnapshot' | 'error'
>>;

const DbServiceContext = createContext<{
    addDownload: (record: Omit<DownloadRecord, 'id' | 'downloadedAt'>) => Promise<number>;
    updateDownload: (id: number, update: DownloadUpdate) => Promise<void>;
    getHistory: () => Promise<DownloadRecord[]>;
    getActiveDownloadCount: () => Promise<number>;
    deleteRecord: (id: number) => Promise<void>;
} | null>(null);

// Database initialization routine run natively on first boot
async function migrateDbIfNeeded(db: SQLiteDatabase) {
    await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS download_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      localPath TEXT NOT NULL,
      fileSize INTEGER,
      resolution TEXT,
      thumbnail TEXT,
      downloadedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      mediaAssetId TEXT,
      cancelToken TEXT,
      resumeSnapshot TEXT,
      mode TEXT NOT NULL DEFAULT 'default',
      formatId TEXT NOT NULL DEFAULT '',
      serverBoost INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'completed',
      progress REAL NOT NULL DEFAULT 100,
      taskId TEXT,
      error TEXT
    );`
    );

    const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(download_history);');
    const existingColumns = new Set(columns.map((column) => column.name));
    const migrations: [string, string][] = [
        ['mediaAssetId', 'ALTER TABLE download_history ADD COLUMN mediaAssetId TEXT;'],
        ['cancelToken', 'ALTER TABLE download_history ADD COLUMN cancelToken TEXT;'],
        ['resumeSnapshot', 'ALTER TABLE download_history ADD COLUMN resumeSnapshot TEXT;'],
        ['mode', "ALTER TABLE download_history ADD COLUMN mode TEXT NOT NULL DEFAULT 'default';"],
        ['formatId', "ALTER TABLE download_history ADD COLUMN formatId TEXT NOT NULL DEFAULT '';"],
        ['serverBoost', 'ALTER TABLE download_history ADD COLUMN serverBoost INTEGER NOT NULL DEFAULT 1;'],
        ['status', "ALTER TABLE download_history ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';"],
        ['progress', 'ALTER TABLE download_history ADD COLUMN progress REAL NOT NULL DEFAULT 100;'],
        ['taskId', 'ALTER TABLE download_history ADD COLUMN taskId TEXT;'],
        ['error', 'ALTER TABLE download_history ADD COLUMN error TEXT;'],
    ];
    for (const [column, migration] of migrations) {
        if (!existingColumns.has(column)) await db.execAsync(migration);
    }
    await db.runAsync(
        `UPDATE download_history
         SET status = CASE WHEN resumeSnapshot IS NOT NULL THEN 'paused' ELSE 'failed' END,
             error = CASE WHEN resumeSnapshot IS NOT NULL THEN error
                          ELSE 'Download was interrupted when the app closed.' END
         WHERE status IN ('queued', 'processing', 'downloading');`
    );
}

export function DbProvider({ children }: { children: React.ReactNode }) {
    return (
        <SQLiteProvider databaseName="melostream.db" onInit={migrateDbIfNeeded}>
            <DbServiceBridge>{children}</DbServiceBridge>
        </SQLiteProvider>
    );
}

function DbServiceBridge({ children }: { children: React.ReactNode }) {
    const db = useSQLiteContext();

    const addDownload = async (record: Omit<DownloadRecord, 'id' | 'downloadedAt'>): Promise<number> => {
        const result = await db.runAsync(
            `INSERT INTO download_history
             (title, url, localPath, fileSize, resolution, thumbnail, mediaAssetId, cancelToken,
              resumeSnapshot, mode, formatId, serverBoost, status, progress, taskId, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            [
                record.title,
                record.url,
                record.localPath,
                record.fileSize,
                record.resolution,
                record.thumbnail,
                record.mediaAssetId,
                record.cancelToken,
                record.resumeSnapshot,
                record.mode,
                record.formatId,
                record.serverBoost,
                record.status,
                record.progress,
                record.taskId,
                record.error,
            ]
        );
        return result.lastInsertRowId;
    };

    const updateDownload = async (id: number, update: DownloadUpdate) => {
        await db.runAsync(
            `UPDATE download_history
             SET status = COALESCE(?, status),
                 progress = COALESCE(?, progress),
                 localPath = COALESCE(?, localPath),
                 fileSize = COALESCE(?, fileSize),
                 mediaAssetId = COALESCE(?, mediaAssetId),
                 taskId = CASE WHEN ? THEN ? ELSE taskId END,
                 cancelToken = CASE WHEN ? THEN ? ELSE cancelToken END,
                 resumeSnapshot = CASE WHEN ? THEN ? ELSE resumeSnapshot END,
                 error = ?
             WHERE id = ?;`,
            [
                update.status ?? null,
                update.progress ?? null,
                update.localPath ?? null,
                update.fileSize ?? null,
                update.mediaAssetId ?? null,
                update.taskId !== undefined ? 1 : 0,
                update.taskId ?? null,
                update.cancelToken !== undefined ? 1 : 0,
                update.cancelToken ?? null,
                update.resumeSnapshot !== undefined ? 1 : 0,
                update.resumeSnapshot ?? null,
                update.error ?? null,
                id,
            ]
        );
    };

    const getHistory = async (): Promise<DownloadRecord[]> => {
        const result = await db.getAllAsync<DownloadRecord>(
            `SELECT id, title, url, localPath, fileSize, resolution, thumbnail, downloadedAt, mediaAssetId,
                    cancelToken, resumeSnapshot, mode, formatId, serverBoost, status, progress, taskId, error
       FROM download_history ORDER BY downloadedAt DESC;`
        );
        return result;
    };

    const getActiveDownloadCount = async (): Promise<number> => {
        const result = await db.getFirstAsync<{ count: number }>(
            `SELECT COUNT(*) AS count FROM download_history
             WHERE status IN ('queued', 'processing', 'downloading');`
        );
        return result?.count ?? 0;
    };

    const deleteRecord = async (id: number) => {
        await db.runAsync('DELETE FROM download_history WHERE id = ?;', [id]);
    };

    return (
        <DbServiceContext.Provider value={{ addDownload, updateDownload, getHistory, getActiveDownloadCount, deleteRecord }}>
            {children}
        </DbServiceContext.Provider>
    );
}

export const useDb = () => {
    const context = useContext(DbServiceContext);
    if (!context) throw new Error('useDb must be used within a DbProvider');
    return context;
};