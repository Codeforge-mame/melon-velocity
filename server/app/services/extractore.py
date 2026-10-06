import yt_dlp
import asyncio
import os
from typing import Any
from yt_dlp.networking.impersonate import ImpersonateTarget

from app.core.config import settings

# Detect if curl_cffi is available for TLS impersonation (needed for TikTok)
try:
    import curl_cffi  # noqa: F401
    _HAS_CURL_CFFI = True
except ImportError:
    _HAS_CURL_CFFI = False

class VideoExtractorService:
    @staticmethod
    def build_ydl_options() -> dict[str, Any]:
        ydl_opts: dict[str, Any] = {
            'noplaylist': True,
            'extractor_args': {'youtube': ['player-client=android,ios']},
        }

        if _HAS_CURL_CFFI:
            ydl_opts['impersonate'] = ImpersonateTarget.from_str('chrome-131')

        if os.path.isfile(settings.YTDLP_COOKIE_FILE):
            ydl_opts['cookiefile'] = settings.YTDLP_COOKIE_FILE
        elif os.environ.get('YTDLP_COOKIE_FILE'):
            raise FileNotFoundError(
                f"Configured yt-dlp cookie file does not exist: {settings.YTDLP_COOKIE_FILE}"
            )

        return ydl_opts

    @staticmethod
    async def extract_metadata(target_url: str) -> dict:
        ydl_opts = VideoExtractorService.build_ydl_options()

        loop = asyncio.get_event_loop()
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                metadata = await loop.run_in_executor(
                    None, 
                    lambda: ydl.extract_info(target_url, download=False)
                )
        except Exception as e:
            raise RuntimeError(f"yt-dlp core failed: {str(e)}") from e
            
        if not metadata:
            raise RuntimeError("Failed to resolve metadata footprint structures.")

        raw_formats = metadata.get("formats", [])
        parsed_formats = []
        
        for f in raw_formats:
            if f.get("vcodec") != "none" or f.get("acodec") != "none":
                parsed_formats.append({
                    "formatId": str(f.get("format_id", "")),
                    "resolution": f"{f.get('height')}p" if f.get("height") else "Adaptive",
                    "extension": str(f.get("ext", "mp4")),
                    "fileSizeEstimate": f.get("filesize") or f.get("filesize_approx"),
                    "hasVideo": f.get("vcodec") != "none",
                    "hasAudio": f.get("acodec") != "none",
                    "url": str(f.get("url", ""))
                })
                
        return {
            "title": str(metadata.get("title", "Unknown Stream Media")),
            "thumbnail": str(metadata.get("thumbnail", "")),
            "duration": int(metadata.get("duration") or 0),
            "uploader": str(metadata.get("uploader", "External Platform")),
            "sourceUrl": target_url,
            "formats": parsed_formats
        }