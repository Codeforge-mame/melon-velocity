import logging
from typing import Any

import yt_dlp
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

from app.core.cache import cache_service
from app.core.config import settings
from app.core.database import db_service
from app.core.metrics import active_resolutions, resolution_duration, resolution_total
from app.core.queue import request_queue
from app.schema.video import ResolveResponse, VideoFormat, PlaylistResponse, PlaylistItem

logger = logging.getLogger(__name__)


class ResolverError(Exception):
    """Base exception for resolver errors."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


class ResolverService:
    """Service for resolving video metadata and formats using yt-dlp."""

    def __init__(self):
        self.timeout = settings.resolve_timeout_seconds

    def _create_ydl_options(self) -> dict[str, Any]:
        """Create yt-dlp options for metadata extraction."""
        return {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": False,
            "noplaylist": True,
            "skip_download": True,
            "timeout": self.timeout,
            # Don't extract subtitles or other metadata we don't need
            "writesubtitles": False,
            "writeautomaticsub": False,
            # Limit concurrent operations
            "concurrent_fragment_downloads": 1,
        }

    def _generate_format_label(self, fmt: dict[str, Any]) -> str:
        """Generate a human-readable format label."""
        parts = []

        # Resolution
        if fmt.get("height"):
            resolution = f"{fmt['height']}p"
            if fmt.get("width") and fmt["width"] != 1920 and fmt["height"] != 1080:
                resolution = f"{fmt['width']}x{fmt['height']}"
            parts.append(resolution)

        # Extension/container
        ext = fmt.get("ext", "unknown").upper()
        parts.append(ext)

        # FPS if available
        if fmt.get("fps"):
            parts.append(f"{fmt['fps']}fps")

        return " ".join(parts) if parts else "Unknown"

    def _get_format_category(self, fmt: dict[str, Any]) -> str:
        """
        Determine the category of a format.

        Returns:
            'video' if both video and audio are present (merged)
            'video-only' if only video codec is present
            'audio-only' if only audio codec is present
        """
        vcodec = fmt.get("vcodec", "none")
        acodec = fmt.get("acodec", "none")

        if vcodec != "none" and acodec != "none":
            return "video"
        elif vcodec != "none":
            return "video-only"
        elif acodec != "none":
            return "audio-only"
        else:
            return "video"  # Default to video category if unknown

    def _deduplicate_formats(self, formats: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Remove duplicate formats based on format_id."""
        seen = set()
        unique_formats = []

        for fmt in formats:
            fmt_id = fmt.get("format_id")
            if fmt_id and fmt_id not in seen:
                seen.add(fmt_id)
                unique_formats.append(fmt)

        return unique_formats

    def _filter_formats(
        self,
        formats: list[VideoFormat],
        min_height: int | None = None,
        max_height: int | None = None,
        min_filesize: int | None = None,
        max_filesize: int | None = None,
        category: str | None = None,
    ) -> list[VideoFormat]:
        """Filter formats based on specified criteria."""
        filtered_formats = []

        for fmt in formats:
            # Filter by height
            if min_height and fmt.height and fmt.height < min_height:
                continue
            if max_height and fmt.height and fmt.height > max_height:
                continue

            # Filter by file size
            if min_filesize and fmt.fileSizeBytes and fmt.fileSizeBytes < min_filesize:
                continue
            if max_filesize and fmt.fileSizeBytes and fmt.fileSizeBytes > max_filesize:
                continue

            # Filter by category
            if category and fmt.category != category:
                continue

            filtered_formats.append(fmt)

        return filtered_formats

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10),
        retry=retry_if_exception_type((yt_dlp.utils.DownloadError, yt_dlp.utils.ExtractorError)),
        reraise=True,
    )
    def _extract_with_retry(self, ydl, url: str) -> dict:
        """Extract video info with retry logic."""
        return ydl.extract_info(url, download=False)

    async def _resolve_video_internal(
        self,
        url: str,
        min_height: int | None = None,
        max_height: int | None = None,
        min_filesize: int | None = None,
        max_filesize: int | None = None,
        category: str | None = None,
    ) -> ResolveResponse:
        """Internal resolution logic without queue."""
        # Check cache first
        cached = await cache_service.get(url)
        if cached:
            # Apply filters to cached result
            filtered_formats = self._filter_formats(
                cached.formats,
                min_height=min_height,
                max_height=max_height,
                min_filesize=min_filesize,
                max_filesize=max_filesize,
                category=category,
            )
            return ResolveResponse(
                sourceUrl=cached.sourceUrl,
                title=cached.title,
                thumbnailUrl=cached.thumbnailUrl,
                durationSeconds=cached.durationSeconds,
                formats=filtered_formats,
            )

        ydl_opts = self._create_ydl_options()

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = self._extract_with_retry(ydl, url)

                if not info:
                    raise ResolverError("VIDEO_UNAVAILABLE", "Could not extract video information")

                # Check for age restrictions or access issues
                if info.get("age_limit"):
                    raise ResolverError(
                        "AGE_OR_ACCESS_RESTRICTION",
                        f"Video has age restriction: {info['age_limit']}",
                    )

                if info.get("availability") == "private":
                    raise ResolverError(
                        "AGE_OR_ACCESS_RESTRICTION",
                        "Video is private or requires authentication",
                    )

                # Extract metadata
                title = info.get("title") or "Unknown Title"
                thumbnail_url = info.get("thumbnail")
                duration = info.get("duration")

                # Extract subtitles
                subtitles = []
                if info.get("subtitles"):
                    for lang, sub_list in info.get("subtitles", {}).items():
                        for sub in sub_list:
                            if sub.get("url"):
                                subtitles.append({
                                    "language": lang,
                                    "url": sub.get("url"),
                                    "ext": sub.get("ext", "vtt"),
                                })

                # Extract and filter formats
                raw_formats = info.get("formats", [])

                # Deduplicate
                raw_formats = self._deduplicate_formats(raw_formats)

                # Convert to API format (include all categories)
                api_formats = []
                seen_urls = set()

                for fmt in raw_formats:
                    download_url = fmt.get("url")

                    # Skip formats without a direct download URL
                    if not download_url:
                        continue

                    # Skip duplicate URLs
                    if download_url in seen_urls:
                        continue
                    seen_urls.add(download_url)

                    # Check if authorization is required
                    requires_auth = fmt.get("http_headers", {}).get("Authorization") is not None

                    format_obj = VideoFormat(
                        formatId=fmt.get("format_id", "unknown"),
                        label=self._generate_format_label(fmt),
                        container=fmt.get("ext", "mp4"),
                        fileSizeBytes=fmt.get("filesize"),
                        downloadUrl=download_url,
                        requiresAuthorization=requires_auth,
                        category=self._get_format_category(fmt),
                        height=fmt.get("height"),
                    )
                    api_formats.append(format_obj)

                # Apply filters
                api_formats = self._filter_formats(
                    api_formats,
                    min_height=min_height,
                    max_height=max_height,
                    min_filesize=min_filesize,
                    max_filesize=max_filesize,
                    category=category,
                )

                if not api_formats:
                    raise ResolverError(
                        "UNSUPPORTED_SITE",
                        "No downloadable formats available for this video matching the specified filters",
                    )

                response = ResolveResponse(
                    sourceUrl=url,
                    title=title,
                    thumbnailUrl=thumbnail_url,
                    durationSeconds=int(duration) if duration else None,
                    formats=api_formats,
                    subtitles=subtitles,
                )

                # Cache the result
                await cache_service.set(url, response)

                return response

        except yt_dlp.utils.DownloadError as e:
            error_msg = str(e).lower()
            if "age" in error_msg or "sign in" in error_msg or "login" in error_msg:
                raise ResolverError("AGE_OR_ACCESS_RESTRICTION", "Video requires authentication or has age restrictions")
            elif "unavailable" in error_msg or "not found" in error_msg:
                raise ResolverError("VIDEO_UNAVAILABLE", "Video is unavailable or not found")
            else:
                raise ResolverError("EXTRACTION_FAILED", f"Failed to extract video: {e!s}")

        except ResolverError:
            # Re-raise ResolverError as-is
            raise

        except yt_dlp.utils.ExtractorError as e:
            raise ResolverError("UNSUPPORTED_SITE", f"Unsupported website: {e!s}")

        except Exception as e:
            logger.exception("Unexpected error during resolution")
            raise ResolverError("EXTRACTION_FAILED", f"Unexpected error: {e!s}")

    async def resolve_video(self, url: str, installation_id: str | None = None, ip_address: str | None = None, min_height: int | None = None, max_height: int | None = None, min_filesize: int | None = None, max_filesize: int | None = None, category: str | None = None) -> ResolveResponse:
        """
        Resolve video metadata and available formats with queueing.

        Args:
            url: Video page URL to resolve
            installation_id: Client installation ID for logging
            ip_address: Client IP address for logging
            min_height: Minimum video height in pixels
            max_height: Maximum video height in pixels
            min_filesize: Minimum file size in bytes
            max_filesize: Maximum file size in bytes
            category: Filter by format category

        Returns:
            ResolveResponse with video metadata and formats

        Raises:
            ResolverError: If resolution fails
        """
        import time
        task_id = f"resolve-{int(time.time() * 1000)}"
        
        async def task():
            active_resolutions.inc()
            start_time = time.time()
            try:
                result = await self._resolve_video_internal(url, min_height, max_height, min_filesize, max_filesize, category)
                
                # Log successful resolution
                db_service.log_resolution(
                    url=url,
                    status="success",
                    title=result.title,
                    installation_id=installation_id,
                    ip_address=ip_address,
                    formats_count=len(result.formats),
                    cached=(await cache_service.get(url) is not None),
                    duration_seconds=int(time.time() - start_time),
                )
                
                resolution_total.labels(status="success").inc()
                resolution_duration.observe(time.time() - start_time)
                return result
            except ResolverError as e:
                # Log failed resolution
                db_service.log_resolution(
                    url=url,
                    status="error",
                    error_code=e.code,
                    error_message=e.message,
                    installation_id=installation_id,
                    ip_address=ip_address,
                    duration_seconds=int(time.time() - start_time),
                )
                
                resolution_total.labels(status="error").inc()
                resolution_duration.observe(time.time() - start_time)
                raise
            except Exception as e:
                # Log unexpected error
                db_service.log_resolution(
                    url=url,
                    status="error",
                    error_code="EXTRACTION_FAILED",
                    error_message=str(e),
                    installation_id=installation_id,
                    ip_address=ip_address,
                    duration_seconds=int(time.time() - start_time),
                )
                
                resolution_total.labels(status="error").inc()
                resolution_duration.observe(time.time() - start_time)
                raise
            finally:
                active_resolutions.dec()

        return await request_queue.add(task_id, task)

    async def resolve_playlist(self, url: str) -> PlaylistResponse:
        """
        Resolve playlist metadata and video list.

        Args:
            url: Playlist URL to resolve

        Returns:
            PlaylistResponse with playlist metadata and video list

        Raises:
            ResolverError: If resolution fails
        """
        ydl_opts = self._create_ydl_options()
        ydl_opts["extract_flat"] = True  # Don't download video info, just list

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)

                if not info:
                    raise ResolverError("VIDEO_UNAVAILABLE", "Could not extract playlist information")

                if info.get("_type") != "playlist":
                    raise ResolverError("UNSUPPORTED_SITE", "URL is not a playlist")

                # Extract playlist metadata
                title = info.get("title") or "Unknown Playlist"
                thumbnail_url = info.get("thumbnail")

                # Extract videos
                videos = []
                entries = info.get("entries", [])

                for entry in entries:
                    if entry and entry.get("url"):
                        videos.append(
                            PlaylistItem(
                                url=entry.get("url"),
                                title=entry.get("title") or "Unknown Video",
                                thumbnailUrl=entry.get("thumbnail"),
                                durationSeconds=entry.get("duration"),
                            )
                        )

                if not videos:
                    raise ResolverError("UNSUPPORTED_SITE", "No videos found in playlist")

                return PlaylistResponse(
                    sourceUrl=url,
                    title=title,
                    thumbnailUrl=thumbnail_url,
                    videos=videos,
                    totalVideos=len(videos),
                )

        except yt_dlp.utils.DownloadError as e:
            error_msg = str(e).lower()
            if "age" in error_msg or "sign in" in error_msg or "login" in error_msg:
                raise ResolverError("AGE_OR_ACCESS_RESTRICTION", "Playlist requires authentication or has age restrictions")
            elif "unavailable" in error_msg or "not found" in error_msg:
                raise ResolverError("VIDEO_UNAVAILABLE", "Playlist is unavailable or not found")
            else:
                raise ResolverError("EXTRACTION_FAILED", f"Failed to extract playlist: {e!s}")

        except ResolverError:
            raise

        except yt_dlp.utils.ExtractorError as e:
            raise ResolverError("UNSUPPORTED_SITE", f"Unsupported website: {e!s}")

        except Exception as e:
            logger.exception("Unexpected error during playlist resolution")
            raise ResolverError("EXTRACTION_FAILED", f"Unexpected error: {e!s}")


# Global resolver service instance
resolver_service = ResolverService()
