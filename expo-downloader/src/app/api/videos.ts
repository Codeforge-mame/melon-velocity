import type { ResolvedVideo } from "@/features/downloads/types";
import { getInstallationId } from "@/utils/installationId";
import { qualityPresetsManager } from "@/features/quality/qualityPresets";
import { networkQualityDetector } from "@/features/network/networkQuality";

const API_URL = process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, "") || "https://cornaceous-abolitionary-bev.ngrok-free.dev";

interface ErrorResponse {
    code: string;
    message: string;
}

interface HealthResponse {
    status: string;
}

/**
 * Check if the backend API is healthy
 */
export async function checkHealth(): Promise<boolean> {
    try {
        const response = await fetch(`${API_URL}/health`);
        const data: HealthResponse = await response.json();
        return data.status === "ok";
    } catch {
        return false;
    }
}

/**
 * Resolve video metadata and formats using the FastAPI backend
 */
export async function resolveVideo(url: string, qualityPreset?: string): Promise<ResolvedVideo> {
    if (!API_URL) {
        throw new Error("EXPO_PUBLIC_API_URL is not configured.");
    }

    const installationId = await getInstallationId();
    
    // Get filter params from quality preset if provided
    let filterParams: any = {};
    if (qualityPreset) {
        filterParams = qualityPresetsManager.getFilterParams(qualityPreset);
    } else {
        // Auto-select based on network quality
        const networkInfo = await networkQualityDetector.getCurrentNetworkInfo();
        const autoPreset = qualityPresetsManager.getPresetForNetwork(networkInfo.quality);
        filterParams = qualityPresetsManager.getFilterParams(autoPreset.id);
    }

    const response = await fetch(`${API_URL}/v1/videos/resolve`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Installation-ID": installationId,
        },
        body: JSON.stringify({ 
            url,
            ...filterParams
        }),
    });

    if (!response.ok) {
        let errorMessage = `Video resolution failed (${response.status})`;
        
        try {
            const errJson: ErrorResponse = await response.json();
            errorMessage = errJson.message || errorMessage;
            
            // Map backend error codes to user-friendly messages
            const errorMessages: Record<string, string> = {
                INVALID_URL: "Invalid URL. Please check the link and try again.",
                UNSUPPORTED_SITE: "This website is not supported.",
                AGE_OR_ACCESS_RESTRICTION: "This video requires authentication or has age restrictions.",
                VIDEO_UNAVAILABLE: "This video is not available or has been removed.",
                SOURCE_TIMEOUT: "The video source did not respond in time. Please try again.",
                EXTRACTION_FAILED: "Failed to extract video information. Please try again.",
                RATE_LIMITED: "Too many requests. Please wait a moment and try again.",
                SERVER_BUSY: "The server is busy. Please try again later.",
            };
            
            if (errJson.code && errorMessages[errJson.code]) {
                errorMessage = errorMessages[errJson.code];
            }
        } catch {
            // If parsing fails, use the status-based message
        }
        
        throw new Error(errorMessage);
    }

    const data = await response.json();

    // Backend returns camelCase fields matching our types
    return {
        sourceUrl: data.sourceUrl || url,
        title: data.title || "Untitled Video",
        thumbnailUrl: data.thumbnailUrl || null,
        durationSeconds: data.durationSeconds || null,
        formats: (data.formats || []).map((f: any) => ({
            formatId: f.formatId || String(Math.random()),
            label: f.label || "Standard",
            container: f.container || "mp4",
            fileSizeBytes: f.fileSizeBytes || null,
            downloadUrl: f.downloadUrl || "",
            requiresAuthorization: f.requiresAuthorization || false,
            category: f.category || "video",
            height: f.height || null,
        })),
        subtitles: data.subtitles || [],
    };
}