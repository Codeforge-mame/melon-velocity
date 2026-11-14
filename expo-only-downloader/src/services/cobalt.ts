import { DownloadMode } from '../db/database';

// Point this to your self-hosted Cobalt instance URL (no trailing slash)
export const COBALT_INSTANCE_URL = 'https://cobalt-production-58fa76fe.up.railway.app';

// Optional: If you enabled API key authentication on your Cobalt instance
const COBALT_API_KEY = process.env.API_KEY;

export type VideoQuality = '2160' | '1440' | '1080' | '720' | '480' | '360' | 'max';

export interface ResolveRequest {
  url: string;
  mode: DownloadMode;       // 'auto' (Audio+Video) | 'mute' (Video Only) | 'audio' (Audio Only)
  quality: VideoQuality;    // '1080' | '720' | '480' | '360' | etc.
}

export interface ResolvedMedia {
  streamUrl: string;
  filename: string;
  title: string;
  isAudio: boolean;
}

export async function resolveMediaUrl({
  url,
  mode,
  quality,
}: ResolveRequest): Promise<ResolvedMedia> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (COBALT_API_KEY) {
    headers['Authorization'] = `Api-Key ${COBALT_API_KEY}`;
  }

  // Build payload matching Cobalt v10+ specification
  const payload: Record<string, unknown> = {
    url: url.trim(),
    downloadMode: mode,
    filenameStyle: 'pretty',
  };

  // Apply resolution filter when downloading video ('auto' or 'mute')
  if (mode !== 'audio') {
    payload.videoQuality = quality;
    payload.youtubeVideoCodec = 'h264'; // Best compatibility for iOS/Android native gallery & players
  } else {
    payload.audioFormat = 'mp3';
    payload.audioBitrate = '128';
  }

  const response = await fetch(`${COBALT_INSTANCE_URL}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok || data.status === 'error') {
    const errorCode = data?.error?.code || 'unknown_error';
    throw new Error(formatCobaltError(errorCode));
  }

  // Case 1: Standard single stream ('tunnel' or 'redirect')
  if (data.status === 'tunnel' || data.status === 'redirect') {
    const rawFilename: string = data.filename || generateFallbackFilename(mode);
    return {
      streamUrl: data.url,
      filename: sanitizeFilename(rawFilename),
      title: stripExtension(rawFilename),
      isAudio: mode === 'audio',
    };
  }

  // Case 2: Multi-item post (e.g. Instagram carousel or slideshow)
  if (data.status === 'picker' && Array.isArray(data.picker) && data.picker.length > 0) {
    const firstItem = data.picker[0];
    const fallbackName = generateFallbackFilename(mode);
    return {
      streamUrl: firstItem.url,
      filename: sanitizeFilename(fallbackName),
      title: `Rooster Media (${data.picker.length} items)`,
      isAudio: mode === 'audio',
    };
  }

  throw new Error(`Unsupported Cobalt response status: ${data.status}`);
}

// --- Helper Functions ---

function sanitizeFilename(name: string): string {
  // Remove characters that break Android/iOS file paths
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^/.]+$/, '');
}

function generateFallbackFilename(mode: DownloadMode): string {
  const ext = mode === 'audio' ? 'mp3' : 'mp4';
  return `rooster_${Date.now()}.${ext}`;
}

function formatCobaltError(code: string): string {
  const errorMap: Record<string, string> = {
    'error.api.link.invalid': 'The URL you entered is invalid or not supported.',
    'error.api.link.unsupported': 'This website is not supported by your Cobalt instance.',
    'error.api.fetch.empty': 'No downloadable media was found at that link.',
    'error.api.fetch.rate': 'Rate limit reached on Cobalt. Try again in a moment.',
    'error.api.youtube.login': 'This video is age-restricted or requires sign-in.',
  };
  return errorMap[code] || `Cobalt error (${code})`;
}
