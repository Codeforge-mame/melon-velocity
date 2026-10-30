export type FormatCategory = "video" | "video-only" | "audio-only";

export type VideoFormat = {
  formatId: string;
  label: string;
  container: string;
  fileSizeBytes: number | null;
  downloadUrl: string;
  requiresAuthorization?: boolean;
  category: FormatCategory;
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

export type PlaylistItem = {
  url: string;
  title: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
};

export type ResolvedPlaylist = {
  sourceUrl: string;
  title: string;
  thumbnailUrl: string | null;
  videos: PlaylistItem[];
  totalVideos: number;
};

export type ResolveFilters = {
  min_height?: number;
  max_height?: number;
  min_filesize?: number;
  max_filesize?: number;
  category?: FormatCategory;
};

export type DownloadStatus =
  | "queued"
  | "downloading"
  | "paused"
  | "completed"
  | "error";

export type DownloadRecord = {
  id: string;
  title: string;
  thumbnailUrl?: string | null;
  filename: string;
  url: string;
  formatId: string;
  resolutionLabel: string;
  status: DownloadStatus;
  bytesWritten: number;
  totalBytes: number;
  localUri?: string | null;
  error?: string | null;
  resumeData?: string | null;
  createdAt: number;
};
