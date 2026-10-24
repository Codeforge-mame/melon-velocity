export type VideoFormat = {
    formatId: string;
    label: string;
    container: string;
    fileSizeBytes: number | null;
    downloadUrl: string;
    requiresAuthorization?: boolean;
    category: 'video' | 'video-only' | 'audio-only';
    height?: number | null;
};

export type Subtitle = {
    language: string;
    url: string;
    ext: string;
};

export type ResolvedVideo = {
    sourceUrl: string;
    title: string;
    thumbnailUrl: string | null;
    durationSeconds: number | null;
    formats: VideoFormat[];
    subtitles: Subtitle[];
};