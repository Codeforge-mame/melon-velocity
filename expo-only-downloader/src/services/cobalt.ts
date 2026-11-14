import { DownloadMode } from '../db/database';

export const COBALT_INSTANCE_URL = 'https://cobalt-production-58fa76fe.up.railway.app';
const COBALT_API_KEY = process.env.API_KEY; // Match your Railway API_KEY

export type VideoQuality = '2160' | '1440' | '1080' | '720' | '480' | '360' | 'max';

export interface ResolveRequest {
  url: string;
  mode: DownloadMode;
  quality: VideoQuality;
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

  const payload: Record<string, unknown> = {
    url: url.trim(),
    downloadMode: mode,
    filenameStyle: 'pretty',
    alwaysProxy: false, // Allow direct CDN downloads whenever supported for max speed
  };

  if (mode !== 'audio') {
    payload.videoQuality = quality;
    payload.youtubeVideoCodec = 'h264';
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
    const service = data?.error?.context?.service || '';
    throw new Error(formatCobaltError(errorCode, service));
  }

  if (data.status === 'tunnel' || data.status === 'redirect') {
    const rawFilename: string = data.filename || generateFallbackFilename(mode);
    return {
      streamUrl: data.url,
      filename: sanitizeFilename(rawFilename),
      title: stripExtension(rawFilename),
      isAudio: mode === 'audio',
    };
  }

  if (data.status === 'picker' && Array.isArray(data.picker) && data.picker.length > 0) {
    const firstItem = data.picker;
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

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^/.]+$/, '');
}

function generateFallbackFilename(mode: DownloadMode): string {
  const ext = mode === 'audio' ? 'mp3' : 'mp4';
  return `rooster_${Date.now()}.${ext}`;
}

function formatCobaltError(code: string, service: string): string {
  const site = service ? ` (${service})` : '';
  const errorMap: Record<string, string> = {
    'error.api.link.invalid': 'Invalid URL format. Check the link and try again.',
    'error.api.link.unsupported': `This website${site} is not supported by Cobalt.`,
    'error.api.fetch.empty': `No downloadable media found${site}. Post may be private.`,
    'error.api.fetch.rate': `Rate limit hit${site}. Wait a moment or add a proxy on Railway.`,
    'error.api.fetch.critical': `Server blocked by ${service || 'platform'}. Datacenter IP or cookies needed.`,
    'error.api.youtube.login': 'YouTube blocked this datacenter IP (bot check). Add a proxy or cookies on Railway.',
  };
  return errorMap[code] || `Cobalt error${site}: ${code}`;
}