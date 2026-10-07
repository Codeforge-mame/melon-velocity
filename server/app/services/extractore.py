import yt_dlp
import asyncio
from typing import Any
from urllib.parse import urlparse
from yt_dlp.networking.impersonate import ImpersonateTarget

from app.models import SocialPlatform

# Detect if curl_cffi is available for TLS impersonation (needed for TikTok)
try:
    import curl_cffi  # noqa: F401
    _HAS_CURL_CFFI = True
except ImportError:
    _HAS_CURL_CFFI = False

class VideoExtractorService:
    @staticmethod
    def platform_for_url(target_url: str) -> SocialPlatform | None:
        host = (urlparse(target_url).hostname or "").lower().removeprefix("www.")
        if host == "youtu.be" or host == "youtube.com" or host.endswith(".youtube.com"):
            return "youtube"
        if host == "tiktok.com" or host.endswith(".tiktok.com"):
            return "tiktok"
        if host in {"t.me", "telegram.me", "telegram.org", "telegra.ph"} or any(
            host.endswith(f".{domain}")
            for domain in ("telegram.me", "telegram.org", "telegra.ph")
        ):
            return "telegram"
        return None

    @staticmethod
    def build_ydl_options(cookie_file: str | None = None) -> dict[str, Any]:
        ydl_opts: dict[str, Any] = {
            'noplaylist': True,
            'extractor_args': {'youtube': ['player-client=android,ios']},
        }

        if _HAS_CURL_CFFI:
            ydl_opts['impersonate'] = ImpersonateTarget.from_str('chrome-131')

        if cookie_file:
            ydl_opts['cookiefile'] = cookie_file

        return ydl_opts

    @staticmethod
    async def extract_metadata(target_url: str, cookie_file: str | None = None) -> dict:
        ydl_opts = VideoExtractorService.build_ydl_options(cookie_file)

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
                    "url": str(f.get("url", "")) if not cookie_file else ""
                })
                
        return {
            "title": str(metadata.get("title", "Unknown Stream Media")),
            "thumbnail": str(metadata.get("thumbnail", "")),
            "duration": int(metadata.get("duration") or 0),
            "uploader": str(metadata.get("uploader", "External Platform")),
            "sourceUrl": target_url,
            "formats": parsed_formats
        }