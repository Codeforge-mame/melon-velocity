export type VideoFormat = {
    formatId: string;
    label: string;
    container: string;
    fileSizeBytes: number | null;
    downloadUrl: string;
    requiresAuthorization?: boolean;
};

export type ResolvedVideo = {
    sourceUrl: string;
    title: string;
    thumbnailUrl: string | null;
    durationSeconds: number | null;
    formats: VideoFormat[];
};