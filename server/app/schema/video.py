
from pydantic import BaseModel, Field


class VideoFormat(BaseModel):
    """Represents a downloadable video format."""

    formatId: str = Field(..., description="Unique identifier for the format")
    label: str = Field(..., description="Human-readable format label (e.g., '720p MP4')")
    container: str = Field(..., description="Container format (e.g., 'mp4', 'webm')")
    fileSizeBytes: int | None = Field(None, description="File size in bytes, if known")
    downloadUrl: str = Field(..., description="Direct URL to download the media")
    requiresAuthorization: bool = Field(
        default=False, description="Whether the URL requires authorization"
    )
    category: str = Field(
        ...,
        description="Format category: 'video' (merged video+audio), 'video-only', or 'audio-only'",
    )
    height: int | None = Field(None, description="Video height in pixels")
    httpHeaders: dict[str, str] = Field(
        default_factory=dict,
        description="HTTP headers required to download this format (e.g. Referer, User-Agent)",
    )


class ResolveRequest(BaseModel):
    """Request to resolve video metadata and formats."""

    url: str = Field(..., description="Video page URL to resolve")
    min_height: int | None = Field(None, description="Minimum video height in pixels")
    max_height: int | None = Field(None, description="Maximum video height in pixels")
    min_filesize: int | None = Field(None, description="Minimum file size in bytes")
    max_filesize: int | None = Field(None, description="Maximum file size in bytes")
    category: str | None = Field(None, description="Filter by category: 'video', 'video-only', 'audio-only'")
    skip_cache: bool = Field(
        default=False,
        description="Skip the cache and force a fresh extraction (used when refreshing expired URLs)",
    )


class ResolveResponse(BaseModel):
    """Response with video metadata and available formats."""

    sourceUrl: str = Field(..., description="Original video page URL")
    title: str = Field(..., description="Video title")
    thumbnailUrl: str | None = Field(None, description="Thumbnail image URL")
    durationSeconds: int | None = Field(None, description="Video duration in seconds")
    formats: list[VideoFormat] = Field(..., description="Available download formats")
    subtitles: list[dict] = Field(default_factory=list, description="Available subtitles")


class PlaylistItem(BaseModel):
    """Single video in a playlist."""
    url: str = Field(..., description="Video URL")
    title: str = Field(..., description="Video title")
    thumbnailUrl: str | None = Field(None, description="Thumbnail URL")
    durationSeconds: int | None = Field(None, description="Duration in seconds")


class PlaylistResponse(BaseModel):
    """Response with playlist metadata and video list."""
    sourceUrl: str = Field(..., description="Original playlist URL")
    title: str = Field(..., description="Playlist title")
    thumbnailUrl: str | None = Field(None, description="Playlist thumbnail URL")
    videos: list[PlaylistItem] = Field(..., description="Videos in the playlist")
    totalVideos: int = Field(..., description="Total number of videos in playlist")


class ErrorResponse(BaseModel):
    """Standard error response."""

    code: str = Field(..., description="Machine-readable error code")
    message: str = Field(..., description="Human-readable error message")


class HealthResponse(BaseModel):
    """Health check response."""

    status: str = Field(default="ok", description="Service health status")
