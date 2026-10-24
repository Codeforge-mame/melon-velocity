import logging

from fastapi import APIRouter, HTTPException, Request, status

from app.core.rate_limit import rate_limiter
from app.schema.video import ErrorResponse, ResolveRequest, ResolveResponse, PlaylistResponse
from app.services.resolver import ResolverError, resolver_service
from app.utils.url_validation import URLValidationError, validate_installation_id, validate_url

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post(
    "/v1/videos/resolve",
    response_model=ResolveResponse,
    responses={
        400: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)
async def resolve_video(request: Request, body: ResolveRequest):
    """
    Resolve video metadata and available formats.

    Rate limited: 10 requests per 10 minutes per installation ID.
    """
    # Extract installation ID from header
    installation_id = request.headers.get("X-Installation-ID")
    ip_address = request.client.host if request.client else None

    # Validate installation ID format if provided
    if installation_id and not validate_installation_id(installation_id):
        logger.warning(f"Invalid installation ID format: {installation_id[:10]}...")
        installation_id = None

    # Check rate limits
    allowed, retry_after = await rate_limiter.check_rate_limit(installation_id, ip_address)

    if not allowed:
        logger.warning(
            f"Rate limit exceeded for installation_id={installation_id}, ip={ip_address}"
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "RATE_LIMITED",
                "message": "Rate limit exceeded. Please try again later.",
            },
            headers={"Retry-After": str(retry_after)} if retry_after else None,
        )

    # Validate URL
    try:
        normalized_url = validate_url(body.url)
    except URLValidationError as e:
        logger.warning(f"URL validation failed: {e.code} - {e.message}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": e.code, "message": e.message},
        )

    # Resolve video
    try:
        logger.info(f"Resolving video: {normalized_url}")
        result = await resolver_service.resolve_video(
            normalized_url,
            installation_id=installation_id,
            ip_address=ip_address,
            min_height=body.min_height,
            max_height=body.max_height,
            min_filesize=body.min_filesize,
            max_filesize=body.max_filesize,
            category=body.category,
        )
        logger.info(f"Successfully resolved: {result.title} with {len(result.formats)} formats")
        return result
    except ResolverError as e:
        logger.warning(f"Resolver error: {e.code} - {e.message}")
        # Map resolver error codes to HTTP status codes
        status_map = {
            "INVALID_URL": status.HTTP_400_BAD_REQUEST,
            "UNSUPPORTED_SITE": status.HTTP_400_BAD_REQUEST,
            "AGE_OR_ACCESS_RESTRICTION": status.HTTP_403_FORBIDDEN,
            "VIDEO_UNAVAILABLE": status.HTTP_404_NOT_FOUND,
            "SOURCE_TIMEOUT": status.HTTP_504_GATEWAY_TIMEOUT,
            "EXTRACTION_FAILED": status.HTTP_500_INTERNAL_SERVER_ERROR,
            "RATE_LIMITED": status.HTTP_429_TOO_MANY_REQUESTS,
            "SERVER_BUSY": status.HTTP_503_SERVICE_UNAVAILABLE,
        }
        http_status = status_map.get(e.code, status.HTTP_500_INTERNAL_SERVER_ERROR)
        raise HTTPException(
            status_code=http_status,
            detail={"code": e.code, "message": e.message},
        )
    except Exception:
        logger.exception("Unexpected error during resolution")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "EXTRACTION_FAILED",
                "message": "An unexpected error occurred while resolving the video.",
            },
        )


@router.post(
    "/v1/playlists/resolve",
    response_model=PlaylistResponse,
    responses={
        400: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)
async def resolve_playlist(request: Request, body: ResolveRequest):
    """
    Resolve playlist metadata and video list.

    Rate limited: 10 requests per 10 minutes per installation ID.
    """
    # Extract installation ID from header
    installation_id = request.headers.get("X-Installation-ID")
    ip_address = request.client.host if request.client else None

    # Validate installation ID format if provided
    if installation_id and not validate_installation_id(installation_id):
        logger.warning(f"Invalid installation ID format: {installation_id[:10]}...")
        installation_id = None

    # Check rate limits
    allowed, retry_after = await rate_limiter.check_rate_limit(installation_id, ip_address)

    if not allowed:
        logger.warning(
            f"Rate limit exceeded for installation_id={installation_id}, ip={ip_address}"
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "RATE_LIMITED",
                "message": "Rate limit exceeded. Please try again later.",
            },
            headers={"Retry-After": str(retry_after)} if retry_after else None,
        )

    # Validate URL
    try:
        normalized_url = validate_url(body.url)
    except URLValidationError as e:
        logger.warning(f"URL validation failed: {e.code} - {e.message}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": e.code, "message": e.message},
        )

    # Resolve playlist
    try:
        logger.info(f"Resolving playlist: {normalized_url}")
        result = await resolver_service.resolve_playlist(normalized_url)
        logger.info(f"Successfully resolved playlist: {result.title} with {result.totalVideos} videos")
        return result
    except ResolverError as e:
        logger.warning(f"Resolver error: {e.code} - {e.message}")
        # Map resolver error codes to HTTP status codes
        status_map = {
            "INVALID_URL": status.HTTP_400_BAD_REQUEST,
            "UNSUPPORTED_SITE": status.HTTP_400_BAD_REQUEST,
            "AGE_OR_ACCESS_RESTRICTION": status.HTTP_403_FORBIDDEN,
            "VIDEO_UNAVAILABLE": status.HTTP_404_NOT_FOUND,
            "SOURCE_TIMEOUT": status.HTTP_504_GATEWAY_TIMEOUT,
            "EXTRACTION_FAILED": status.HTTP_500_INTERNAL_SERVER_ERROR,
            "RATE_LIMITED": status.HTTP_429_TOO_MANY_REQUESTS,
            "SERVER_BUSY": status.HTTP_503_SERVICE_UNAVAILABLE,
        }
        http_status = status_map.get(e.code, status.HTTP_500_INTERNAL_SERVER_ERROR)
        raise HTTPException(
            status_code=http_status,
            detail={"code": e.code, "message": e.message},
        )
    except Exception:
        logger.exception("Unexpected error during playlist resolution")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "EXTRACTION_FAILED",
                "message": "An unexpected error occurred while resolving the playlist.",
            },
        )
