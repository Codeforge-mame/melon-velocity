import * as MediaLibrary from "expo-media-library";
import {
    completeHandler,
    createDownloadTask,
    directories,
    getExistingDownloadTasks,
    setConfig,
} from "@kesha-antonov/react-native-background-downloader";

import { getDatabase } from "../../db/database";
import { downloadQueue } from "./downloadQueue";
import { retryManager } from "./retryManager";
import { notificationManager } from "../notifications/notificationManager";
import { preferencesManager } from "../preferences/preferencesManager";

type DownloadInput = {
    id: string;
    url: string;
    title: string;
    thumbnailUrl?: string;
    filename: string;
    formatId?: string;
    resolutionLabel?: string;
};

type NativeTask = ReturnType<typeof createDownloadTask>;

const activeTasks = new Map<string, NativeTask>();
const attachedTasks = new Set<string>();

function safeFilename(name: string) {
    const clean = name
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
        .trim()
        .slice(0, 150);

    return clean || `video-${Date.now()}.mp4`;
}

async function updateDownload(
    id: string,
    values: {
        status?: string;
        downloadedBytes?: number;
        totalBytes?: number | null;
        fileUri?: string | null;
        errorMessage?: string | null;
        completed?: boolean;
    },
) {
    const db = await getDatabase();
    const hasErrorMessage = Object.prototype.hasOwnProperty.call(values, "errorMessage")

    await db.runAsync(`
        UPDATE downloads SET
status = COALESCE(?, status),
        downloaded_bytes = COALESCE(?, downloaded_bytes),
        total_bytes = COALESCE(?, total_bytes),
        file_uri = COALESCE(?, file_uri),
        error_message = CASE WHEN ? = 1 THEN ? ELSE error_message END,
        completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE completed_at END,
        updated_at = CURRENT_TIMESTAMP
WHERE id = ?`,
        values.status ?? null,
        values.downloadedBytes ?? null,
        values.totalBytes ?? null,
        values.fileUri ?? null,
        hasErrorMessage ? 1 : 0,
        values.errorMessage ?? null,
        values.completed ? 1 : 0,
        id,
    );
}

async function saveToGalleryForDownload(
    downloadId: string,
    path: string,
) {
    const db = await getDatabase();

    const row = await db.getFirstAsync<{
        gallery_saved: number;
    }>(
        "SELECT gallery_saved FROM downloads WHERE id = ?",
        downloadId,
    );

    if (row?.gallery_saved === 1) {
        return;
    }

    const permission = await MediaLibrary.requestPermissionsAsync(
        false,
        ["video"],
    );

    if (!permission.granted) {
        throw new Error("Gallery permission was not granted.");
    }

    const assetUri = path.startsWith("file://")
        ? path
        : `file://${path}`;

    const asset = await MediaLibrary.createAssetAsync(assetUri);

    await db.runAsync(`
    UPDATE downloads
     SET gallery_asset_id = ?,
         gallery_saved = 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
        asset.id,
        downloadId,
    );
}

function attachCallbacks(task: NativeTask) {
    if (attachedTasks.has(task.id)) return;

    attachedTasks.add(task.id);
    activeTasks.set(task.id, task);

    task
        .begin(({ expectedBytes }) => {
            void updateDownload(task.id, {
                status: "downloading",
                totalBytes: expectedBytes >= 0 ? expectedBytes : null,
            });
        })
        .progress(({ bytesDownloaded, bytesTotal }) => {
            void updateDownload(task.id, {
                status: "downloading",
                downloadedBytes: bytesDownloaded,
                totalBytes: bytesTotal >= 0 ? bytesTotal : null,
            });
        })
        .done(async ({ location, bytesDownloaded, bytesTotal }) => {
            try {
                await updateDownload(task.id, {
                    status: "completed",
                    downloadedBytes: bytesDownloaded,
                    totalBytes: bytesTotal >= 0 ? bytesTotal : null,
                    fileUri: location,
                    completed: true,
                });

                await downloadQueue.markCompleted(task.id);
                await retryManager.resetRetryCount(task.id);

                try {
                    await saveToGalleryForDownload(task.id, location);
                } catch (error) {
                    // The file is already downloaded. Gallery permission or saving
                    // can be retried separately without downloading the file again.
                    await updateDownload(task.id, {
                        errorMessage:
                            error instanceof Error
                                ? `Downloaded, but gallery save failed: ${error.message}`
                                : "Downloaded, but gallery save failed.",
                    });
                }
            } catch (error) {
                console.error("Failed to finalize download record:", error);
            } finally {
                activeTasks.delete(task.id);
                attachedTasks.delete(task.id);
                completeHandler(task.id);
            }
        })
        .error(async ({ error, errorCode }) => {
            await updateDownload(task.id, {
                status: "failed",
                errorMessage: `${error}(code ${errorCode})`,
            });
            
            await downloadQueue.markFailed(task.id, `${error}(code ${errorCode})`);
            await retryManager.incrementRetryCount(task.id);
            
            const prefs = preferencesManager.getPreferences();
            if (prefs?.enableAutoRetry && await retryManager.shouldRetry(task.id)) {
                await retryManager.markForRetry(task.id);
            }
            
            const title = (task.metadata?.title as string) || "Unknown";
            await notificationManager.showDownloadFailed(task.id, title, `${error}(code ${errorCode})`);
            
            activeTasks.delete(task.id);
            attachedTasks.delete(task.id);
        });
}

export async function startDownload(input: DownloadInput) {
    const db = await getDatabase();
    const filename = safeFilename(input.filename);
    const destination = `${directories.documents}/${input.id}-${filename}`;

    await db.runAsync(`INSERT INTO downloads(
            id, source_url, title, thumbnail_url, format_id, resolution_label,
            file_name, status, task_id, downloaded_bytes, updated_at, added_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        input.id,
        input.url,
        input.title,
        input.thumbnailUrl ?? null,
        input.formatId ?? null,
        input.resolutionLabel ?? null,
        filename,
        input.id,
    );

    await downloadQueue.addToQueue({
        id: input.id,
        url: input.url,
        title: input.title,
        thumbnailUrl: input.thumbnailUrl,
        filename,
        formatId: input.formatId,
        resolutionLabel: input.resolutionLabel,
    });

    await notificationManager.showDownloadStarted(input.id, input.title);

    const task = createDownloadTask({
        id: input.id,
        url: input.url,
        destination,
        metadata: {
            title: input.title,
            filename,
            formatId: input.formatId ?? "",
        },
    });

    attachCallbacks(task);
    task.start();

    await updateDownload(input.id, { status: "downloading" });
}

export async function pauseDownload(id: string) {
    const task = activeTasks.get(id);
    if (!task) throw new Error("Download task is not attached.");

    await task.pause();
    await updateDownload(id, { status: "paused" });
    await downloadQueue.pauseDownload(id);
    const title = (task.metadata?.title as string) || "Unknown";
    await notificationManager.showDownloadPaused(id, title);
}

export async function resumeDownload(id: string) {
    const task = activeTasks.get(id);
    if (!task) throw new Error("Download task is not attached.");

    await task.resume();
    await updateDownload(id, { status: "downloading" });
    await downloadQueue.resumeDownload(id);
}

export async function retryDownload(id: string) {
    const db = await getDatabase();
    const row = await db.getFirstAsync<{
        source_url: string;
        title: string | null;
        thumbnail_url: string | null;
        file_name: string;
        format_id: string | null;
        resolution_label: string | null;
    }>(
        `SELECT source_url, title, thumbnail_url, file_name, format_id, resolution_label
FROM downloads WHERE id = ?`,
        id,
    );

    if (!row) throw new Error("Download record not found.");

    await db.runAsync("DELETE FROM downloads WHERE id = ?", id);

    const thumbnail_url = row.thumbnail_url ?? undefined;

    await startDownload({
        id: `${id} - retry - ${Date.now()}`,
        url: row.source_url,
        title: row.title ?? row.file_name,
        thumbnailUrl: thumbnail_url,
        filename: row.file_name,
        formatId: row.format_id ?? undefined,
        resolutionLabel: row.resolution_label ?? undefined,
    });
}

export async function retryGallerySave(downloadId: string) {
    const db = await getDatabase();

    const row = await db.getFirstAsync<{
        file_uri: string | null;
        status: string;
    }>(
        `SELECT file_uri, status
     FROM downloads
     WHERE id = ?`,
        downloadId,
    );

    if (!row) {
        throw new Error("Download record was not found.");
    }

    if (row.status !== "completed") {
        throw new Error("Only completed downloads can be saved to the gallery.");
    }

    if (!row.file_uri) {
        throw new Error("The downloaded file location is missing.");
    }

    await saveToGalleryForDownload(downloadId, row.file_uri);

    // Clear the old gallery-save error after a successful retry.
    await updateDownload(downloadId, {
        errorMessage: null,
    });
}

export async function deleteDownload(id: string) {
    const db = await getDatabase();

    // First, get the download info to check if we need to delete the file
    const row = await db.getFirstAsync<{
        file_uri: string | null;
        task_id: string | null;
    }>(
        `SELECT file_uri, task_id FROM downloads WHERE id = ?`,
        id,
    );

    if (!row) {
        throw new Error("Download record not found.");
    }

    // Delete from database
    await db.runAsync("DELETE FROM downloads WHERE id = ?", id);

    // Optionally delete the file from filesystem if needed
    // This is commented out as the file might still be in use by gallery
    // if (row.file_uri) {
    //     try {
    //         const FileSystem = require("expo-file-system");
    //         await FileSystem.deleteAsync(row.file_uri);
    //     } catch (error) {
    //         console.warn("Failed to delete file:", error);
    //     }
    // }
}

export async function deleteFromGallery(downloadId: string) {
    const db = await getDatabase();

    const row = await db.getFirstAsync<{
        gallery_asset_id: string | null;
        gallery_saved: number;
    }>(
        `SELECT gallery_asset_id, gallery_saved FROM downloads WHERE id = ?`,
        downloadId,
    );

    if (!row) {
        throw new Error("Download record not found.");
    }

    if (row.gallery_saved !== 1 || !row.gallery_asset_id) {
        throw new Error("Video is not saved in the gallery.");
    }

    try {
        await MediaLibrary.deleteAssetsAsync([row.gallery_asset_id]);

        // Update database to reflect gallery deletion
        await db.runAsync(`
            UPDATE downloads
            SET gallery_asset_id = NULL,
                gallery_saved = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
            downloadId,
        );
    } catch (error) {
        throw new Error(
            error instanceof Error
                ? `Failed to delete from gallery: ${error.message}`
                : "Failed to delete from gallery."
        );
    }
}

async function reconcileCompletedTask(task: NativeTask) {
    const db = await getDatabase();

    const row = await db.getFirstAsync<{
        gallery_saved: number;
        file_uri: string | null;
    }>(
        `SELECT gallery_saved, file_uri
     FROM downloads
     WHERE id = ?`,
        task.id,
    );

    if (!row) {
        console.warn(
            `No SQLite record found for completed task ${task.id}`,
        );
        return;
    }

    // The native task's destination identifies where its file was saved.
    const destination = task.downloadParams?.destination;

    const fileUri = row.file_uri ?? destination;
    if (!fileUri) {
        await updateDownload(task.id, {
            status: "completed",
            downloadedBytes: task.bytesDownloaded,
            totalBytes:
                task.bytesTotal >= 0 ? task.bytesTotal : null,
            fileUri,
            completed: true,
        });

        return;
    }


    // This helper checks gallery_saved before creating another asset.
    if (row.gallery_saved !== 1) {
        try {
            await saveToGalleryForDownload(task.id, fileUri as string);
        } catch (error) {
            await updateDownload(task.id, {
                errorMessage:
                    error instanceof Error
                        ? `Downloaded, but gallery save failed: ${error.message}`
                        : "Downloaded, but gallery save failed.",
            });
        }
    }
}

export async function recoverDownloads() {
    setConfig({
        progressInterval: 1000,
        progressMinBytes: 256 * 1024,
        isLogsEnabled: __DEV__,
    });

    const tasks = await getExistingDownloadTasks();
    const nativeIds = new Set(tasks.map((task) => task.id));

    for (const task of tasks) {
        // Reattach callbacks so progress and completion are handled.
        attachCallbacks(task);

        switch (task.state) {
            case "PAUSED": {
                await updateDownload(task.id, {
                    status: "paused",
                });
                break;
            }

            case "FAILED": {
                await updateDownload(task.id, {
                    status: "failed",
                    errorMessage: "The native download task failed. Retry it.",
                });
                break;
            }

            case "STOPPED": {
                await updateDownload(task.id, {
                    status: "canceled",
                });
                break;
            }

            case "DONE": {
                try {
                    await reconcileCompletedTask(task)
                } catch (error) {
                    console.error(`Faild to recover completed download ${task.id}:`, error)
                } finally {
                    activeTasks.delete(task.id)
                    attachedTasks.delete(task.id)
                    completeHandler(task.id)
                }
            }

            case "PENDING":
            case "DOWNLOADING":
            default: {
                await updateDownload(task.id, {
                    status: "downloading",
                });
                break;
            }
        }
    }

    const db = await getDatabase();

    // Find downloads that SQLite thinks are active but that
    // the native downloader can no longer find.
    const rows = await db.getAllAsync<{
        id: string;
        status: string;
    }>(`
    SELECT id, status
    FROM downloads
    WHERE status IN ('queued', 'downloading', 'paused')
  `);

    for (const row of rows) {
        if (!nativeIds.has(row.id)) {
            await updateDownload(row.id, {
                status: "failed",
                errorMessage:
                    "Native download task not found after app restart. Please retry.",
            });
        }
    }

    return tasks.length;
}