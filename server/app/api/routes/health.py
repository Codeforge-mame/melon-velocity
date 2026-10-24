from fastapi import APIRouter

from app.schema.video import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint - does not count against rate limits."""
    return HealthResponse(status="ok")
