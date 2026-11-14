import { getInstallationId } from "@/utils/installationId";
import type {
  ResolveFilters,
  ResolvedPlaylist,
  ResolvedVideo,
  VideoFormat,
  FormatCategory,
} from "@/features/downloads/types";

export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL ?? "https://cornaceous-abolitionary-bev.ngrok-free.dev"
).replace(/\/+$/, "");

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_URL: "Invalid URL. Please check the link and try again.",
  UNSUPPORTED_SITE: "This website is not supported.",
  AGE_OR_ACCESS_RESTRICTION:
    "This video requires authentication or has age restrictions.",
  VIDEO_UNAVAILABLE: "This video is not available or has been removed.",
  SOURCE_TIMEOUT: "The source did not respond in time. Please try again.",
  EXTRACTION_FAILED: "Failed to extract video information. Please try again.",
  RATE_LIMITED: "Too many requests. Please wait a moment and try again.",
  SERVER_BUSY: "The server is busy. Please try again later.",
};

async function readError(response: Response): Promise<ApiError> {
  let code = "UNKNOWN";
  let message = `Request failed (${response.status})`;

  try {
    const body = await response.json();
    const detail = body?.detail ?? body;
    if (detail?.code) code = detail.code;
    if (detail?.message) message = detail.message;
  } catch {
    // keep defaults
  }

  if (code !== "UNKNOWN" && ERROR_MESSAGES[code]) {
    message = ERROR_MESSAGES[code];
  }

  return new ApiError(code, message, response.status);
}

async function authHeaders(): Promise<Record<string, string>> {
  const installationId = await getInstallationId();
  return {
    "Content-Type": "application/json",
    "X-Installation-ID": installationId,
  };
}

export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/health`);
    if (!response.ok) return false;
    const data = await response.json();
    return data?.status === "ok";
  } catch {
    return false;
  }
}

function normalizeFormat(raw: any): VideoFormat {
  return {
    formatId: raw.formatId ?? raw.format_id ?? "unknown",
    label: raw.label ?? "Standard",
    container: raw.container ?? raw.ext ?? "mp4",
    fileSizeBytes: raw.fileSizeBytes ?? null,
    downloadUrl: raw.downloadUrl ?? "",
    requiresAuthorization: raw.requiresAuthorization ?? false,
    category: (raw.category ?? "video") as FormatCategory,
    height: raw.height ?? null,
    httpHeaders: raw.httpHeaders ?? raw.http_headers ?? {},
  };
}

export async function resolveVideo(
  url: string,
  filters: ResolveFilters = {},
  skipCache = false,
): Promise<ResolvedVideo> {
  const response = await fetch(`${API_URL}/v1/videos/resolve`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ url, ...filters, skip_cache: skipCache }),
  });

  if (!response.ok) throw await readError(response);

  const data = await response.json();

  return {
    sourceUrl: data.sourceUrl ?? url,
    title: data.title ?? "Untitled",
    thumbnailUrl: data.thumbnailUrl ?? null,
    durationSeconds: data.durationSeconds ?? null,
    formats: (data.formats ?? []).map(normalizeFormat),
    subtitles: data.subtitles ?? [],
  };
}

/**
 * Force a fresh resolution (bypassing the server cache) to obtain unexpired
 * download URLs and headers. Used by the download retry path on 403/404.
 */
export async function refreshVideo(url: string): Promise<ResolvedVideo> {
  return resolveVideo(url, {}, true);
}

export async function resolvePlaylist(url: string): Promise<ResolvedPlaylist> {
  const response = await fetch(`${API_URL}/v1/playlists/resolve`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ url }),
  });

  if (!response.ok) throw await readError(response);

  const data = await response.json();

  return {
    sourceUrl: data.sourceUrl ?? url,
    title: data.title ?? "Untitled playlist",
    thumbnailUrl: data.thumbnailUrl ?? null,
    videos: (data.videos ?? []).map((v: any) => ({
      url: v.url,
      title: v.title ?? "Untitled",
      thumbnailUrl: v.thumbnailUrl ?? null,
      durationSeconds: v.durationSeconds ?? null,
    })),
    totalVideos: data.totalVideos ?? 0,
  };
}
