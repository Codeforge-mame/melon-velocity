import { useQuery } from '@tanstack/react-query';
import { BACKEND_BASE_URL } from '../constants/config';

export interface VideoFormat {
    formatId: string;
    resolution: string;
    extension: string;
    fileSizeEstimate: number | null;
    hasVideo: boolean;
    hasAudio: boolean;
    url: string;
}

export interface VideoMetadata {
    title: string;
    thumbnail: string;
    duration: number;
    uploader: string;
    sourceUrl: string;
    formats: VideoFormat[];
}

export function useFastApiMetadata(targetUrl: string) {
    return useQuery<VideoMetadata, Error>({
        queryKey: ['fastApiMetadata', targetUrl],
        queryFn: async () => {
            const response = await fetch(`${BACKEND_BASE_URL}/info`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: targetUrl }),
            });

            if (!response.ok) {
                if (response.status === 429) {
                    throw new Error('Rate limit reached! Please wait 30 seconds before searching again.');
                }
                const err = await response.json();
                throw new Error(err.detail || 'Failed to extract video links.');
            }
            return response.json();
        },
        enabled: !!targetUrl && targetUrl.startsWith('http'),
        staleTime: 1000 * 60 * 5,
        retry: false,
    });
}