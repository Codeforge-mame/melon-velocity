import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DownloadRecord, useDb } from '../context/DbContext';

export interface VideoFormat {
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
    formats: VideoFormat[];
}

// Fetch helper communicating with our Expo Router API Route
const fetchVideoMetadata = async (targetUrl: string): Promise<VideoMetadataResponse> => {
    const response = await fetch('/api/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
    });

    if (!response.ok) {
        if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After') || '30';
            throw new Error(`Rate limited! Please wait ${retryAfter} seconds.`);
        }
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to extract media links.');
    }

    return response.json();
};

// 1. Hook to scan/parse incoming URLs
export function useVideoMetadata(targetUrl: string) {
    return useQuery<VideoMetadataResponse, Error>({
        queryKey: ['videoMetadata', targetUrl],
        queryFn: () => fetchVideoMetadata(targetUrl),
        enabled: !!targetUrl && targetUrl.startsWith('http'), // Only fire when a URL is valid
        staleTime: 1000 * 60 * 5, // Cache platform lookups for 5 minutes
        retry: false, // Don't spam the scraper endpoint on failure
    });
}

// 2. Hook to fetch local offline database logs
export function useDownloadHistory() {
    const { getHistory } = useDb();
    return useQuery<DownloadRecord[], Error>({
        queryKey: ['downloadHistory'],
        queryFn: getHistory,
    });
}

// 3. Mutation to record a completed download item into history
export function useLogDownload() {
    const queryClient = useQueryClient();
    const { addDownload } = useDb();

    return useMutation({
        mutationFn: addDownload,
        onSuccess: () => {
            // Invalidate the cache to instantly update the History Screen list without a pull-to-refresh
            queryClient.invalidateQueries({ queryKey: ['downloadHistory'] });
        },
    });
}

// 4. Mutation to remove a file from local database history
export function useDeleteHistoryItem() {
    const queryClient = useQueryClient();
    const { deleteRecord } = useDb();

    return useMutation({
        mutationFn: deleteRecord,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['downloadHistory'] });
        },
    });
}