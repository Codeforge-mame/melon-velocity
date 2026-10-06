import asyncio
import logging
import os
import uuid

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from app.core.celery_app import celery_app
from app.core.config import settings
from app.schemas.video import (
    DownloadQueuedResponse,
    DownloadStatusResponse,
    VideoDownloadRequest,
    VideoInfoRequest,
    VideoMetadataResponse,
)
from app.services.extractore import VideoExtractorService
from app.services.tasks import download_video_task

logger = logging.getLogger(__name__)
router = APIRouter()


async def delayed_cleanup(path: str, delay_seconds: int = 120) -> None:
    await asyncio.sleep(delay_seconds)
    try:
        os.remove(path)
    except FileNotFoundError:
        return
    except OSError:
        logger.exception("Failed to clean up streamed video %s.", path)


@router.post("/info", response_model=VideoMetadataResponse)
async def get_video_info(payload: VideoInfoRequest):
    try:
        return await VideoExtractorService.extract_metadata(payload.url)
    except Exception as exc:
        logger.exception("Failed to extract metadata for a video URL.")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post(
    "/download",
    response_model=DownloadQueuedResponse,
    status_code=202,
)
async def download_video(payload: VideoDownloadRequest):
    file_id = str(uuid.uuid4())[:8]
    try:
        task = await run_in_threadpool(
            download_video_task.apply_async,
            args=[payload.url, payload.format_id, file_id],
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


@router.get("/download/{task_id}", response_model=DownloadStatusResponse)
async def get_download_status(task_id: str):
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
async def stream_file_to_mobile(file_name: str, background_tasks: BackgroundTasks):
    if os.path.basename(file_name) != file_name:
        raise HTTPException(status_code=400, detail="Invalid file name.")

    file_path = os.path.join(settings.DOWNLOAD_DIR, file_name)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Requested file not found on storage cache.")

    background_tasks.add_task(delayed_cleanup, file_path, 120)
    return FileResponse(file_path, media_type="video/mp4", filename=file_name)
