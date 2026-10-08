from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis as AsyncRedis

from app.core.config import settings
from app.core.middlware import RateLimitMiddleware
from app.api.routes import router as api_router
from app.api.auth import router as auth_router


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        redis_client = AsyncRedis.from_url(settings.REDIS_URL)
        try:
            await redis_client.ping()
            application.state.rate_limit_redis = redis_client
            yield
        finally:
            await redis_client.aclose()

    application = FastAPI(
        title=settings.PROJECT_NAME,
        version="1.0.0",
        lifespan=lifespan,
    )
    application.add_middleware(RateLimitMiddleware)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=[
            origin.strip()
            for origin in settings.CORS_ORIGINS.split(",")
            if origin.strip()
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.include_router(api_router, prefix=settings.API_V1_STR)
    application.include_router(auth_router, prefix=f"{settings.API_V1_STR}/auth")
    return application

app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)