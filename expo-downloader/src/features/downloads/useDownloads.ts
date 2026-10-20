import { useQuery } from "@tanstack/react-query";
import { getDatabase } from "../../db/database";

export type DownloadRow = {
    id: string;
    title: string | null;
    thumbnail_url: string | null;
    file_name: string;
    file_uri: string | null;
    status: string;
    downloaded_bytes: number;
    total_bytes: number | null;
    error_message: string | null;
    gallery_saved: number;
    gallery_asset_id: string | null;
    created_at: string;
    updated_at: string | null;
};

export function useDownloads() {
    return useQuery({
        queryKey: ["downloads"],
        queryFn: async () => {
            const db = await getDatabase();

            return db.getAllAsync<DownloadRow>(
                `SELECT id, title, thumbnail_url, file_name, file_uri, status,
                downloaded_bytes, total_bytes, error_message, gallery_saved, gallery_asset_id, created_at, updated_at
                FROM downloads
                ORDER BY created_at DESC
            `);

        },
        refetchInterval: 1000,
    });
}