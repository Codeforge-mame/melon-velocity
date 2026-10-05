import os
import uuid
import asyncio
from fastapi import APIRouter, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse
from app.schemas.video import VideoInfoRequest, VideoDownloadRequest, VideoMetadataResponse, DownloadReadyResponse
from app.services.extractore import VideoExtractorService
from app.services.downloader import SegmentedDownloaderService
from app.core.config import settings

router = APIRouter()

async def delayed_cleanup(path: str, delay_seconds: int = 120):
    await asyncio.sleep(delay_seconds)
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception:
        pass

@router.post("/info", response_model=VideoMetadataResponse)
async def get_video_info(payload: VideoInfoRequest):
    try:
        metadata = await VideoExtractorService.extract_metadata(payload.url)
        return metadata
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/download", response_model=DownloadReadyResponse)
async def download_video(payload: VideoDownloadRequest):
    try:
        meta = await VideoExtractorService.extract_metadata(payload.url)
        target_format = next((f for f in meta["formats"] if f["formatId"] == payload.format_id), None)
        
        if not target_format:
            raise HTTPException(status_code=404, detail="Selected video profile is no longer active.")
            
        size = target_format.get("fileSizeEstimate") or 0
        file_uuid = str(uuid.uuid4())[:8]
        
        file_path = await SegmentedDownloaderService.execute_parallel_download(target_format["url"], size, file_uuid)
        actual_size = os.path.getsize(file_path) if os.path.exists(file_path) else size
        
        return DownloadReadyResponse(
            success=True,
            message="Multi-threaded server processing complete.",
            fileName=os.path.basename(file_path),
            fileSize=actual_size
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/stream/{file_name}")
async def stream_file_to_mobile(file_name: str, background_tasks: BackgroundTasks):
    file_path = os.path.join(settings.DOWNLOAD_DIR, file_name)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Requested file not found on storage cache.")
    
    # Auto-cleanup utility to free server space 2 minutes after delivery
    background_tasks.add_task(delayed_cleanup, file_path, 120)
    return FileResponse(file_path, media_type="video/mp4", filename=file_name)