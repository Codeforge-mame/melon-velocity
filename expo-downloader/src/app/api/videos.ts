import type { ResolvedVideo } from "@/features/downloads/types";

// const API_URL = process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, "");
const API_URL = "https://cornaceous-abolitionary-bev.ngrok-free.dev"

export async function resolveVideo(url: string): Promise<ResolvedVideo> {
    if (!API_URL) {
        throw new Error("EXPO_PUBLIC_API_URL is not configured.");
    }

    // Attempt FastAPI backend (/api/v1/info), fallback to /v1/videos/resolve
    let endpoint = `${API_URL}/api/v1/info`;
    let response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ url, mode: "default" }),
    });

    if (response.status === 404) {
        endpoint = `${API_URL}/v1/videos/resolve`;
        response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ url }),
        });
    }

    if (!response.ok) {
        let message = "";
        try {
            const errJson = await response.json();
            message = errJson.detail || errJson.message || "";
        } catch {
            message = await response.text();
        }
        throw new Error(message || `Video resolution failed (${response.status})`);
    }

    const data = await response.json();

    // Support both FastAPI VideoMetadataResponse and ResolvedVideo format
    return {
        sourceUrl: data.sourceUrl ?? data.source_url ?? url,
        title: data.title || "Untitled Video",
        thumbnailUrl: data.thumbnailUrl ?? data.thumbnail ?? null,
        durationSeconds: data.durationSeconds ?? data.duration ?? null,
        formats: (data.formats || []).map((f: any) => ({
            formatId: f.formatId ?? f.format_id ?? String(Math.random()),
            label: f.label ?? f.resolution ?? "Standard",
            container: f.container ?? f.extension ?? "mp4",
            fileSizeBytes: f.fileSizeBytes ?? f.fileSizeEstimate ?? f.file_size_estimate ?? null,
            downloadUrl: f.downloadUrl ?? f.url,
            requiresAuthorization: f.requiresAuthorization ?? false,
        })),
    };
}