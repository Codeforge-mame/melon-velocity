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
}

const DbServiceContext = createContext<{
    addDownload: (record: Omit<DownloadRecord, 'id' | 'downloadedAt'>) => Promise<void>;
    getHistory: () => Promise<DownloadRecord[]>;
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
      downloadedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );`
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

    const addDownload = async (record: Omit<DownloadRecord, 'id' | 'downloadedAt'>) => {
        await db.runAsync(
            `INSERT INTO download_history (title, url, localPath, fileSize, resolution, thumbnail) 
       VALUES (?, ?, ?, ?, ?, ?);`,
            [record.title, record.url, record.localPath, record.fileSize, record.resolution, record.thumbnail]
        );
    };

    const getHistory = async (): Promise<DownloadRecord[]> => {
        const result = await db.getAllAsync<any>(
            `SELECT id, title, url, localPath as localPath, fileSize as fileSize, resolution, thumbnail, downloadedAt as downloadedAt 
       FROM download_history ORDER BY downloadedAt DESC;`
        );
        return result.map(row => ({
            id: row.id,
            title: row.title,
            url: row.url,
            localPath: row.localPath,
            fileSize: row.fileSize,
            resolution: row.resolution,
            thumbnail: row.thumbnail,
            downloadedAt: row.downloadedAt,
        }));
    };

    const deleteRecord = async (id: number) => {
        await db.runAsync('DELETE FROM download_history WHERE id = ?;', [id]);
    };

    return (
        <DbServiceContext.Provider value={{ addDownload, getHistory, deleteRecord }}>
            {children}
        </DbServiceContext.Provider>
    );
}

export const useDb = () => {
    const context = useContext(DbServiceContext);
    if (!context) throw new Error('useDb must be used within a DbProvider');
    return context;
};