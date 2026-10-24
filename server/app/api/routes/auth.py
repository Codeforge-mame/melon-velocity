import logging
from datetime import timedelta

from fastapi import APIRouter, HTTPException, status, Depends
from pydantic import BaseModel, Field

from app.core.auth import create_access_token, decode_access_token, APIKey
from app.core.config import settings

logger = logging.getLogger(__name__)

router = APIRouter()


class APIKeyRequest(BaseModel):
    """Request to generate an API key."""
    pass


class APIKeyResponse(BaseModel):
    """Response with generated API key."""
    api_key: str = Field(..., description="Generated API key")
    expires_in_hours: int = Field(..., description="Token expiration time in hours")


class TokenRequest(BaseModel):
    """Request to get an access token."""
    api_key: str = Field(..., description="API key")


class TokenResponse(BaseModel):
    """Response with access token."""
    access_token: str = Field(..., description="JWT access token")
    token_type: str = Field(default="bearer", description="Token type")


@router.post("/v1/auth/api-key", response_model=APIKeyResponse)
async def generate_api_key():
    """Generate a new API key for API access."""
    api_key = APIKey.generate_key()
    logger.info("Generated new API key")
    return APIKeyResponse(
        api_key=api_key,
        expires_in_hours=settings.jwt_expiration_hours,
    )


@router.post("/v1/auth/token", response_model=TokenResponse)
async def get_access_token(request: TokenRequest):
    """Exchange API key for JWT access token."""
    # In production, validate API key against database
    # For MVP, we'll accept any non-empty key
    if not request.api_key or len(request.api_key) < 10:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "INVALID_API_KEY", "message": "Invalid API key"},
        )
    
    access_token = create_access_token(
        data={"api_key": request.api_key},
        expires_delta=timedelta(hours=settings.jwt_expiration_hours),
    )
    
    logger.info("Generated access token")
    return TokenResponse(access_token=access_token)


async def verify_token(token: str) -> dict:
    """Verify JWT token and return payload."""
    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "INVALID_TOKEN", "message": "Invalid or expired token"},
        )
    return payload


async def optional_auth(token: str | None = None) -> dict | None:
    """Optional authentication - returns None if no token provided."""
    if not token:
        return None
    return await verify_token(token)
