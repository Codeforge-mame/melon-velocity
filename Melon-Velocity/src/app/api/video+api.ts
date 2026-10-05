import youtubeDl from 'youtube-dl-exec';

// --- 1. TYPE DEFINITIONS & CONTRACTS ---
interface TokenBucket {
    tokens: number;
    lastRefill: number;
}

export interface VideoFormatPayload {
    formatId: string;
    resolution: string;
    extension: string;
    fileSizeEstimate: number | null;
    hasVideo: boolean;
    hasAudio: boolean;
    url: string;
}

export interface VideoMetadataResponse {
    title: string;
    thumbnail: string;
    duration: number;
    uploader: string;
    sourceUrl: string;
    formats: VideoFormatPayload[];
}

// --- 2. TOKEN BUCKET RATE LIMITER ---
const RATE_LIMIT_BUCKETS = new Map<string, TokenBucket>();
const MAX_TOKENS = 5;
const REFILL_INTERVAL_MS = 30000; // Refill 1 token every 30 seconds

function checkRateLimit(ip: string): { isAllowed: boolean; remaining: number; retryAfter: number } {
    const now = Date.now();
    if (!RATE_LIMIT_BUCKETS.has(ip)) {
        RATE_LIMIT_BUCKETS.set(ip, { tokens: MAX_TOKENS, lastRefill: now });
        return { isAllowed: true, remaining: MAX_TOKENS - 1, retryAfter: 0 };
    }

    const bucket = RATE_LIMIT_BUCKETS.get(ip)!;
    const timePassed = now - bucket.lastRefill;
    const tokensToAdd = Math.floor(timePassed / REFILL_INTERVAL_MS);

    if (tokensToAdd > 0) {
        bucket.tokens = Math.min(MAX_TOKENS, bucket.tokens + tokensToAdd);
        bucket.lastRefill = now - (timePassed % REFILL_INTERVAL_MS);
    }

    if (bucket.tokens > 0) {
        bucket.tokens -= 1;
        return { isAllowed: true, remaining: bucket.tokens, retryAfter: 0 };
    }

    const retryAfter = Math.ceil((REFILL_INTERVAL_MS - (now - bucket.lastRefill)) / 1000);
    return { isAllowed: false, remaining: 0, retryAfter };
}

// --- 3. EXPO ROUTER POST HANDLER ---
export async function POST(request: Request): Promise<Response> {
    const clientIp = request.headers.get('x-forwarded-for') || 'global-client';
    const rateLimit = checkRateLimit(clientIp);

    // Initialize unified modern web headers object
    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', 'application/json');
    responseHeaders.set('X-RateLimit-Limit', MAX_TOKENS.toString());
    responseHeaders.set('X-RateLimit-Remaining', rateLimit.remaining.toString());

    // Anti-caching directives to ensure token accuracy and fresh stream URLs
    responseHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    responseHeaders.set('Pragma', 'no-cache');
    responseHeaders.set('Expires', '0');

    if (!rateLimit.isAllowed) {
        responseHeaders.set('Retry-After', rateLimit.retryAfter.toString());
        return Response.json(
            { error: `Too many requests. Please retry after ${rateLimit.retryAfter} seconds. ` },
            { status: 429, headers: responseHeaders }
        );
    }

    try {
        const body = await request.json() as { url?: string };
        const targetUrl = body.url;

        if (!targetUrl || !targetUrl.startsWith('http')) {
            return Response.json(
                { error: 'A valid target video URL is required.' },
                { status: 400, headers: responseHeaders }
            );
        }

        // Direct binary extraction loop with strict mobile client spoofing configurations
        const rawMetadata = await youtubeDl(targetUrl, {
            dumpSingleJson: true,
            noPlaylist: true,
            extractorArgs: 'youtube:player-client=android,ios',
        }) as Record<string, any>;

        const rawFormats = (rawMetadata.formats || []) as Record<string, any>[];

        const availableFormats: VideoFormatPayload[] = rawFormats
            .filter((f) => f.vcodec !== 'none' || f.acodec !== 'none')
            .map((f) => ({
                formatId: String(f.format_id || ''),
                resolution: f.height ? `${f.height}p` : 'Adaptive',
                extension: String(f.ext || 'mp4'),
                fileSizeEstimate: typeof f.filesize === 'number' ? f.filesize : typeof f.filesize_approx === 'number' ? f.filesize_approx : null,
                hasVideo: f.vcodec !== 'none',
                hasAudio: f.acodec !== 'none',
                url: String(f.url || ''),
            }));


        const responsePayload: VideoMetadataResponse = {
            title: String(rawMetadata.title || 'Unknown Stream Media'),
            thumbnail: String(rawMetadata.thumbnail || ''),
            duration: Number(rawMetadata.duration || 0),
            uploader: String(rawMetadata.uploader || 'External Platform'),
            sourceUrl: targetUrl,
            formats: availableFormats,
        };

        return Response.json(responsePayload, { status: 200, headers: responseHeaders });

    } catch (error: unknown) {
        console.error('[MeloStream Backend Execution Error]:', error);
        return Response.json(
            { error: 'Failed to extract video links. Verify the URL and try again.' },
            { status: 500, headers: responseHeaders }
        );
    }
}