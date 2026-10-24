import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import auth, health, videos
from app.api.routes.auth import optional_auth
from app.core.config import settings
from app.core.database import db_service
from app.core.metrics import metrics_endpoint
from app.core.redis_client import redis_client

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper()),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Create FastAPI application
app = FastAPI(
    title="Video Resolver API",
    description="FastAPI + yt-dlp video metadata and format resolver",
    version="0.1.0",
    docs_url="/docs" if settings.is_development else None,
    redoc_url="/redoc" if settings.is_development else None,
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.is_development else [],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Include routers
app.include_router(health.router, tags=["health"])
app.include_router(videos.router, tags=["videos"])
app.include_router(auth.router, tags=["auth"])

# Metrics endpoint
app.add_route("/metrics", metrics_endpoint)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log all incoming requests."""
    logger.info(f"{request.method} {request.url.path}")
    response = await call_next(request)
    logger.info(f"{request.method} {request.url.path} - Status: {response.status_code}")
    return response


@app.on_event("startup")
async def startup_event():
    """Run on application startup."""
    logger.info(f"Starting Video Resolver API in {settings.app_env} mode")
    logger.info(f"Rate limit: {settings.rate_limit_requests} requests per {settings.rate_limit_window_seconds} seconds")
    logger.info(f"Resolve timeout: {settings.resolve_timeout_seconds} seconds")
    
    # Initialize database
    db_service.init_db()
    logger.info("Database initialized")


@app.on_event("shutdown")
async def shutdown_event():
    """Run on application shutdown."""
    logger.info("Shutting down Video Resolver API")
    await redis_client.close()
