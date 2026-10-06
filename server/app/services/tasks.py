import glob
import logging
import os
import re
import shutil

import yt_dlp

from app.core.celery_app import celery_app
from app.core.config import settings
from app.services.extractore import VideoExtractorService

logger = logging.getLogger(__name__)
FORMAT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")


@celery_app.task(bind=True, max_retries=3, default_retry_delay=10)
def download_video_task(self, target_url: str, format_id: str, file_id: str) -> dict[str, str | int]:
    if not FORMAT_ID_PATTERN.fullmatch(format_id):
        raise ValueError("The selected video format ID is invalid.")

    task_temp_dir = os.path.join(
        settings.TEMP_DIR,
        f"task_{self.request.id}_{self.request.retries}",
    )
    output_path = os.path.join(settings.DOWNLOAD_DIR, f"melo_{file_id}.mp4")
    os.makedirs(task_temp_dir, exist_ok=True)

    try:
        ydl_opts = VideoExtractorService.build_ydl_options()
        ydl_opts.update(
            {
                "format": f"{format_id}+bestaudio/best",
                "outtmpl": os.path.join(settings.DOWNLOAD_DIR, f"melo_{file_id}.%(ext)s"),
                "paths": {"temp": task_temp_dir},
                "merge_output_format": "mp4",
                "postprocessors": [
                    {"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}
                ],
                "http_chunk_size": 5 * 1024 * 1024,
                "concurrent_fragment_downloads": 4,
                "retries": 3,
                "socket_timeout": 30,
            }
        )

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(target_url, download=True)

        if not os.path.isfile(output_path):
            reported_path = info.get("filepath") if info else None
            if not reported_path or not os.path.isfile(reported_path):
                raise FileNotFoundError("yt-dlp completed without producing an output video.")
            if os.path.splitext(reported_path)[1].lower() != ".mp4":
                raise RuntimeError("FFmpeg did not produce the requested MP4 container.")
            output_path = reported_path

        for intermediate_path in glob.glob(
            os.path.join(settings.DOWNLOAD_DIR, f"melo_{file_id}.*")
        ):
            if os.path.abspath(intermediate_path) != os.path.abspath(output_path):
                try:
                    os.remove(intermediate_path)
                except FileNotFoundError:
                    pass

        shutil.rmtree(task_temp_dir)
        return {
            "fileName": os.path.basename(output_path),
            "fileSize": os.path.getsize(output_path),
        }
    except Exception as exc:
        logger.exception("Video download task %s failed.", self.request.id)
        for partial_path in glob.glob(
            os.path.join(settings.DOWNLOAD_DIR, f"melo_{file_id}.*")
        ):
            try:
                os.remove(partial_path)
            except FileNotFoundError:
                pass
            except OSError:
                logger.exception("Failed to remove partial download %s.", partial_path)

        try:
            shutil.rmtree(task_temp_dir)
        except FileNotFoundError:
            pass
        except OSError:
            logger.exception("Failed to remove temporary download directory %s.", task_temp_dir)

        raise self.retry(exc=exc) from exc
