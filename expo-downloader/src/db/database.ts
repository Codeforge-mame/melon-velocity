import * as SQLite from 'expo-sqlite';

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

export function getDatabase() {
    if (!databasePromise) {
        databasePromise = SQLite.openDatabaseAsync('downloader.db');
    }
    return databasePromise;
}

async function ensureColumn(
    db: SQLite.SQLiteDatabase,
    columnName: string,
    definition: string
) {
    const columns = await db.getAllAsync<{ name: string }>("PRAGMA table_info(downloads)");
    if (!columns.some((column) => column.name === columnName)) {
        await db.execAsync(`
            ALTER TABLE downloads ADD COLUMN ${columnName} ${definition}
        `);
    }
}

export async function initializeDatabase() {
    const db = await getDatabase();
    // Initialize database tables here

    await db.execAsync(`
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS downloads (
         id TEXT PRIMARY KEY NOT NULL,
         source_url TEXT NOT NULL,
         title TEXT,
         thumbnail_url TEXT,
         format_id TEXT,
         resolution_label TEXT,
         file_name TEXT,
         file_uri TEXT,
         status TEXT NOT NULL DEFAULT 'queued'
           CHECK (status IN ('queued', 'downloading', 'paused', 'completed', 'failed', 'canceled')),
         total_bytes INTEGER,
         downloaded_bytes INTEGER NOT NULL DEFAULT 0,
         task_id TEXT UNIQUE,
         error_message TEXT,
         gallery_asset_id TEXT,
         gallery_saved INTEGER NOT NULL DEFAULT 0,
         completed_at TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         queue_position INTEGER,
         retry_count INTEGER NOT NULL DEFAULT 0,
         last_retry_at TEXT,
         started_at TEXT,
         added_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_downloads_created_at ON downloads(created_at DESC);
    `);

    await ensureColumn(db, "completed_at", "TEXT");
    await ensureColumn(db, "gallery_asset_id", "TEXT");
    await ensureColumn(db, "gallery_saved", "INTEGER NOT NULL DEFAULT 0");
    await ensureColumn(db, "queue_position", "INTEGER");
    await ensureColumn(db, "retry_count", "INTEGER NOT NULL DEFAULT 0");
    await ensureColumn(db, "last_retry_at", "TEXT");
    await ensureColumn(db, "started_at", "TEXT");
    await ensureColumn(db, "added_at", "TEXT");
}