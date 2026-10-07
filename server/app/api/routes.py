import asyncio
import glob
import logging
import os
import re
import shutil
import tempfile
import uuid

import yt_dlp
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import get_current_user, get_optional_user
from app.core.celery_app import celery_app
from app.core.config import settings
from app.db import SessionLocal, get_db
from app.models import User, UserSocialAccount
from app.schemas.video import (
    AppMode,
    DownloadQueuedResponse,
    DownloadStatusResponse,
    VideoDownloadRequest,
    VideoInfoRequest,
    VideoMetadataResponse,
)
from app.services.extractore import VideoExtractorService
from app.services.social_sessions import (
    SocialAccountMissingError,
    temporary_cookie_file,
)
from app.services.tasks import download_video_task

logger = logging.getLogger(__name__)
router = APIRouter()
FORMAT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")


def validate_platform_mode(target_url: str, mode: AppMode, user: User | None):
    platform = VideoExtractorService.platform_for_url(target_url)
    if platform is None:
        if mode != "default":
            raise HTTPException(
                status_code=400,
                detail="This platform mode only accepts its matching social platform URL.",
            )
        return None
    if mode == "default" or user is None:
        raise HTTPException(status_code=401, detail="Please log in to download this video")
    if mode != platform:
        raise HTTPException(
            status_code=400,
            detail=f"Switch to {platform.title()} mode to download this URL.",
        )
    return platform


async def delayed_cleanup(path: str, delay_seconds: int = 120) -> None:
    await asyncio.sleep(delay_seconds)
    try:
        os.remove(path)
    except FileNotFoundError:
        return
    except OSError:
        logger.exception("Failed to clean up streamed video %s.", path)


@router.post("/info", response_model=VideoMetadataResponse)
async def get_video_info(
    payload: VideoInfoRequest,
    user: User | None = Depends(get_optional_user),
    db: Session = Depends(get_db),
):
    platform = validate_platform_mode(payload.url, payload.mode, user)

    try:
        if platform and user:
            with temporary_cookie_file(db, user.id, platform) as cookie_file:
                return await VideoExtractorService.extract_metadata(payload.url, cookie_file)
        return await VideoExtractorService.extract_metadata(payload.url)
    except SocialAccountMissingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to extract metadata for a video URL.")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post(
    "/download",
    response_model=DownloadQueuedResponse,
    status_code=202,
)
async def download_video(
    payload: VideoDownloadRequest,
    user: User | None = Depends(get_optional_user),
    db: Session = Depends(get_db),
):
    if not FORMAT_ID_PATTERN.fullmatch(payload.format_id):
        raise HTTPException(status_code=400, detail="The selected video format ID is invalid.")
    platform = validate_platform_mode(payload.url, payload.mode, user)
    if platform:
        account = db.scalar(
            select(UserSocialAccount).where(
                UserSocialAccount.user_id == user.id,
                UserSocialAccount.platform == platform,
            )
        )
        if account is None:
            raise HTTPException(
                status_code=400,
                detail=f"No {platform} session cookies are saved for this account.",
            )

    file_id = (
        f"{user.id}_{uuid.uuid4()}"
        if platform and user
        else str(uuid.uuid4())
    )
    try:
        task = await run_in_threadpool(
            download_video_task.apply_async,
            args=[payload.url, payload.format_id, file_id, str(user.id) if platform and user else None],
        )
    except Exception as exc:
        logger.exception("Failed to enqueue video download.")
        raise HTTPException(
            status_code=503,
            detail="The download queue is unavailable. Please try again shortly.",
        ) from exc

    return DownloadQueuedResponse(
        success=True,
        message="Video download queued.",
        taskId=task.id,
    )


def _run_authenticated_direct_download(
    target_url: str, format_id: str, user_id: uuid.UUID
) -> tuple[str, str]:
    temp_dir = tempfile.mkdtemp(prefix="melostream-direct-", dir=settings.TEMP_DIR)
    try:
        platform = VideoExtractorService.platform_for_url(target_url)
        if platform is None:
            raise ValueError("The authenticated direct download is only for supported platforms.")

        with SessionLocal() as db:
            with temporary_cookie_file(db, user_id, platform) as cookie_file:
                options = VideoExtractorService.build_ydl_options(cookie_file)
                options.update(
                    {
                        "format": f"{format_id}+bestaudio/best",
                        "outtmpl": os.path.join(temp_dir, "video.%(ext)s"),
                        "merge_output_format": "mp4",
                        "postprocessors": [
                            {"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}
                        ],
                    }
                )
                with yt_dlp.YoutubeDL(options) as downloader:
                    info = downloader.extract_info(target_url, download=True)

        candidate = info.get("filepath") if info else None
        if candidate and os.path.isfile(candidate):
            return temp_dir, candidate
        outputs = glob.glob(os.path.join(temp_dir, "video.*"))
        if len(outputs) == 1:
            return temp_dir, outputs[0]
        raise FileNotFoundError("yt-dlp completed without producing a video file.")
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise


@router.get("/download/direct")
async def direct_download(
    background_tasks: BackgroundTasks,
    url: str = Query(min_length=8, max_length=4096),
    format_id: str = Query(min_length=1, max_length=100),
    mode: AppMode = Query(),
    user: User = Depends(get_current_user),
):
    if not FORMAT_ID_PATTERN.fullmatch(format_id):
        raise HTTPException(status_code=400, detail="The selected video format ID is invalid.")
    if validate_platform_mode(url, mode, user) is None:
        raise HTTPException(status_code=400, detail="This endpoint only supports YouTube, TikTok, and Telegram.")
    try:
        temp_dir, output_path = await run_in_threadpool(
            _run_authenticated_direct_download, url, format_id, user.id
        )
    except SocialAccountMissingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Authenticated direct download failed.")
        raise HTTPException(status_code=500, detail="Could not download this video.") from exc

    background_tasks.add_task(shutil.rmtree, temp_dir, True)
    return FileResponse(
        output_path,
        media_type="video/mp4",
        filename=os.path.basename(output_path),
    )


@router.get("/download/{task_id}", response_model=DownloadStatusResponse)
async def get_download_status(
    task_id: str, user: User | None = Depends(get_optional_user)
):
    try:
        uuid.UUID(task_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Download task not found.") from exc

    task = celery_app.AsyncResult(task_id)
    if task.state == "SUCCESS":
        if not isinstance(task.result, dict):
            raise HTTPException(
                status_code=500,
                detail="The download worker returned an invalid result.",
            )
        task_user_id = task.result.get("userId")
        if task_user_id and (user is None or task_user_id != str(user.id)):
            raise HTTPException(status_code=404, detail="Download task not found.")
        return DownloadStatusResponse(
            taskId=task_id,
            status="success",
            fileName=task.result.get("fileName"),
            fileSize=task.result.get("fileSize"),
        )
    if task.state == "FAILURE":
        return DownloadStatusResponse(
            taskId=task_id,
            status="failure",
            error="The server could not complete this download. Please retry.",
        )

    status = {
        "PENDING": "queued",
        "STARTED": "processing",
        "RETRY": "retrying",
    }.get(task.state, task.state.lower())
    return DownloadStatusResponse(taskId=task_id, status=status)


@router.get("/stream/{file_name}")
async def stream_file_to_mobile(
    file_name: str,
    background_tasks: BackgroundTasks,
    user: User | None = Depends(get_optional_user),
):
    if os.path.basename(file_name) != file_name:
        raise HTTPException(status_code=400, detail="Invalid file name.")

    private_file = re.fullmatch(
        r"melo_([0-9a-f-]{36})_[0-9a-f-]{36}\.mp4", file_name
    )
    if private_file and (user is None or private_file.group(1) != str(user.id)):
        raise HTTPException(status_code=404, detail="Requested file not found on storage cache.")

    file_path = os.path.join(settings.DOWNLOAD_DIR, file_name)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Requested file not found on storage cache.")

    background_tasks.add_task(delayed_cleanup, file_path, 120)
    return FileResponse(
        file_path,
        media_type="video/mp4",
        filename=file_name,
        headers={"Cache-Control": "private, no-store" if private_file else "no-store"},
    )
