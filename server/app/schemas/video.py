from pydantic import BaseModel
from typing import List, Literal, Optional

AppMode = Literal["default", "youtube", "telegram", "tiktok"]

class VideoInfoRequest(BaseModel):
    url: str
    mode: AppMode = "default"

class VideoDownloadRequest(BaseModel):
    url: str
    format_id: str
    resolution: str
    mode: AppMode = "default"

class FormatPayload(BaseModel):
    formatId: str
    resolution: str
    extension: str
    fileSizeEstimate: Optional[int] = None
    hasVideo: bool
    hasAudio: bool
    url: str

class VideoMetadataResponse(BaseModel):
    title: str
    thumbnail: str
    duration: int
    uploader: str
    sourceUrl: str
    formats: List[FormatPayload]

class DownloadQueuedResponse(BaseModel):
    success: bool
    message: str
    taskId: str

class DownloadStatusResponse(BaseModel):
    taskId: str
    status: str
    fileName: Optional[str] = None
    fileSize: Optional[int] = None
    error: Optional[str] = None