import asyncio
import logging
import os
import re
import time
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from jose import JWTError, jwt
from redis import Redis
from redis.exceptions import RedisError
from starlette.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import get_current_user, get_optional_user
from app.core.celery_app import celery_app
from app.core.config import settings
from app.db import get_db
from app.models import User, UserSocialAccount
from app.schemas.video import (
    AppMode,
    DownloadCancelRequest,
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
from app.services.tasks import CANCELLED_DOWNLOAD_KEY_PREFIX, download_video_task

logger = logging.getLogger(__name__)
router = APIRouter()
FORMAT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")
CANCEL_TOKEN_LIFETIME_SECONDS = 6 * 60 * 60
STREAM_FILE_TTL_SECONDS = 6 * 60 * 60


def create_cancellation_token(task_id: str, user: User | None) -> str:
    if not settings.JWT_SECRET_KEY:
        raise HTTPException(status_code=503, detail="Download cancellation is unavailable.")
    return jwt.encode(
        {
            "task_id": task_id,
            "sub": str(user.id) if user else "anonymous",
            "purpose": "cancel-download",
            "exp": int(time.time()) + CANCEL_TOKEN_LIFETIME_SECONDS,
        },
        settings.JWT_SECRET_KEY.get_secret_value(),
        algorithm="HS256",
    )


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
    if not settings.JWT_SECRET_KEY:
        raise HTTPException(status_code=503, detail="Download cancellation is unavailable.")
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
        cancellationToken=create_cancellation_token(task.id, user if platform else None),
    )


@router.post("/download/{task_id}/cancel")
async def cancel_download(
    task_id: str,
    payload: DownloadCancelRequest,
    user: User | None = Depends(get_optional_user),
):
    try:
        uuid.UUID(task_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Download task not found.") from exc

    if not settings.JWT_SECRET_KEY:
        raise HTTPException(status_code=503, detail="Download cancellation is unavailable.")
    try:
        claims = jwt.decode(
            payload.cancellationToken,
            settings.JWT_SECRET_KEY.get_secret_value(),
            algorithms=["HS256"],
        )
    except JWTError as exc:
        raise HTTPException(status_code=404, detail="Download task not found.") from exc

    token_user_id = claims.get("sub")
    if (
        claims.get("purpose") != "cancel-download"
        or claims.get("task_id") != task_id
        or (
            token_user_id != "anonymous"
            and (user is None or token_user_id != str(user.id))
        )
    ):
        raise HTTPException(status_code=404, detail="Download task not found.")

    task = celery_app.AsyncResult(task_id)
    if task.state in {"SUCCESS", "FAILURE", "REVOKED"}:
        if (
            task.state == "SUCCESS"
            and isinstance(task.result, dict)
            and task.result.get("status") == "cancelled"
        ):
            return {"taskId": task_id, "status": "cancelled"}
        if task.state == "SUCCESS" and isinstance(task.result, dict):
            result_user_id = task.result.get("userId")
            if result_user_id and token_user_id != str(result_user_id):
                raise HTTPException(status_code=404, detail="Download task not found.")
            file_name = task.result.get("fileName")
            if (
                isinstance(file_name, str)
                and os.path.basename(file_name) == file_name
                and file_name.startswith("melo_")
            ):
                output_path = os.path.join(settings.DOWNLOAD_DIR, file_name)
                try:
                    os.remove(output_path)
                except FileNotFoundError:
                    pass
                except OSError as exc:
                    logger.exception("Failed to remove cancelled output %s.", output_path)
                    raise HTTPException(
                        status_code=500,
                        detail="Could not remove the cancelled server download.",
                    ) from exc
            return {"taskId": task_id, "status": "cancelled"}
        raise HTTPException(status_code=409, detail="This download can no longer be cancelled.")

    redis_client = Redis.from_url(settings.REDIS_URL)
    try:
        await run_in_threadpool(
            redis_client.setex,
            f"{CANCELLED_DOWNLOAD_KEY_PREFIX}{task_id}",
            CANCEL_TOKEN_LIFETIME_SECONDS,
            "1",
        )
    except RedisError as exc:
        logger.exception("Failed to signal cancellation for task %s.", task_id)
        raise HTTPException(status_code=503, detail="The download service is unavailable.") from exc
    finally:
        await run_in_threadpool(redis_client.close)
    return {"taskId": task_id, "status": "cancelling"}


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

    file_id = f"{user.id}_{uuid.uuid4()}"
    try:
        task = await run_in_threadpool(
            download_video_task.apply_async,
            args=[url, format_id, file_id, str(user.id)],
        )
    except Exception as exc:
        logger.exception("Failed to enqueue authenticated direct download.")
        raise HTTPException(
            status_code=503,
            detail="The download queue is unavailable. Please try again shortly.",
        ) from exc

    try:
        result = await run_in_threadpool(task.get)
    except Exception as exc:
        logger.exception("Authenticated direct download task failed.")
        raise HTTPException(status_code=500, detail="Could not download this video.") from exc

    if (
        not isinstance(result, dict)
        or result.get("userId") != str(user.id)
        or not isinstance(result.get("fileName"), str)
        or os.path.basename(result["fileName"]) != result["fileName"]
        or not result["fileName"].startswith(f"melo_{file_id}.")
    ):
        raise HTTPException(status_code=500, detail="The download worker returned an invalid result.")

    output_path = os.path.join(settings.DOWNLOAD_DIR, result["fileName"])
    if not os.path.isfile(output_path):
        raise HTTPException(status_code=500, detail="The download worker did not produce a video.")

    background_tasks.add_task(delayed_cleanup, output_path, STREAM_FILE_TTL_SECONDS)
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
        if task.result.get("status") == "cancelled":
            return DownloadStatusResponse(taskId=task_id, status="cancelled")
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
        "REVOKED": "cancelled",
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

    background_tasks.add_task(delayed_cleanup, file_path, STREAM_FILE_TTL_SECONDS)
    return FileResponse(
        file_path,
        media_type="video/mp4",
        filename=file_name,
        headers={"Cache-Control": "private, no-store" if private_file else "no-store"},
    )
