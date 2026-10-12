import glob
import logging
import os
import re
import shutil
import uuid
from contextlib import ExitStack

from redis import Redis
from redis.exceptions import RedisError
import yt_dlp

from app.core.celery_app import celery_app
from app.core.config import settings
from app.db import SessionLocal
from app.services.extractore import VideoExtractorService
from app.services.social_sessions import temporary_cookie_file

logger = logging.getLogger(__name__)
FORMAT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")
CANCELLED_DOWNLOAD_KEY_PREFIX = "melostream:download-cancel:"


class DownloadCancelledError(Exception):
    pass


def build_download_options(
    format_id: str,
    file_id: str,
    task_temp_dir: str,
    cookie_file: str | None = None,
    output_dir: str | None = None,
) -> dict:
    output_dir = output_dir or settings.DOWNLOAD_DIR
    options = VideoExtractorService.build_ydl_options(cookie_file)
    options.update(
        {
            "format": f"{format_id}+bestaudio/best",
            "outtmpl": os.path.join(output_dir, f"melo_{file_id}.%(ext)s"),
            "paths": {"temp": task_temp_dir},
            "merge_output_format": "mp4",
            "postprocessors": [
                {"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}
            ],
            "http_chunk_size": 5 * 1024 * 1024,
            "concurrent_fragment_downloads": 1,
            "retries": 5,
            "fragment_retries": 5,
            "retry_sleep_functions": {
                "http": lambda attempt: min(2 ** max(attempt - 1, 0), 30),
                "fragment": lambda attempt: min(2 ** max(attempt - 1, 0), 30),
            },
            "socket_timeout": 30,
        }
    )
    return options


@celery_app.task(bind=True, max_retries=3, default_retry_delay=10)
def download_video_task(
    self, target_url: str, format_id: str, file_id: str, user_id: str | None = None
) -> dict[str, str | int | None]:
    if not FORMAT_ID_PATTERN.fullmatch(format_id):
        raise ValueError("The selected video format ID is invalid.")

    platform = VideoExtractorService.platform_for_url(target_url)
    if platform and not user_id:
        raise ValueError("Please log in to download this video")

    task_temp_dir = os.path.join(
        settings.TEMP_DIR,
        f"task_{self.request.id}_{self.request.retries}",
    )
    output_path = os.path.join(settings.DOWNLOAD_DIR, f"melo_{file_id}.mp4")
    os.makedirs(task_temp_dir, exist_ok=True)
    cancel_redis = Redis.from_url(settings.REDIS_URL, socket_timeout=2)

    def check_cancelled(_progress: dict | None = None) -> None:
        try:
            cancelled = cancel_redis.exists(
                f"{CANCELLED_DOWNLOAD_KEY_PREFIX}{self.request.id}"
            )
        except RedisError:
            logger.exception("Could not check cancellation state for task %s.", self.request.id)
            raise
        if cancelled:
            raise DownloadCancelledError("Download cancelled.")

    try:
        check_cancelled()
        with ExitStack() as stack:
            cookie_file = None
            if platform and user_id:
                db = stack.enter_context(SessionLocal())
                cookie_file = stack.enter_context(
                    temporary_cookie_file(db, uuid.UUID(user_id), platform)
                )

            ydl_opts = build_download_options(
                format_id, file_id, task_temp_dir, cookie_file
            )
            ydl_opts["progress_hooks"] = [check_cancelled]

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(target_url, download=True)
            check_cancelled()

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
            "userId": user_id,
        }
    except Exception as exc:
        cancellation_requested = isinstance(exc, DownloadCancelledError)
        if not cancellation_requested:
            try:
                cancellation_requested = bool(
                    cancel_redis.exists(
                        f"{CANCELLED_DOWNLOAD_KEY_PREFIX}{self.request.id}"
                    )
                )
            except RedisError:
                logger.exception(
                    "Could not confirm cancellation state for task %s.",
                    self.request.id,
                )

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

        if cancellation_requested:
            return {
                "status": "cancelled",
                "userId": user_id,
                "fileName": None,
                "fileSize": None,
            }
        logger.exception("Video download task %s failed.", self.request.id)
        raise self.retry(exc=exc) from exc
    finally:
        cancel_redis.close()
