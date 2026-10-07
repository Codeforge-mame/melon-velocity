import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';

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

export type VideoAppMode = 'default' | 'youtube' | 'telegram' | 'tiktok';

export function useFastApiMetadata(targetUrl: string, mode: VideoAppMode) {
    const { apiFetch } = useAuth();
    return useQuery<VideoMetadata, Error>({
        queryKey: ['fastApiMetadata', targetUrl, mode],
        queryFn: async () => {
            const response = await apiFetch('/info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: targetUrl, mode }),
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