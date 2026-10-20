import os
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        case_sensitive=True,
        extra="ignore",
    )

    PROJECT_NAME: str = "MeloStream Engine Backend"
    API_V1_STR: str = "/api/v1"
    DATABASE_URL: str = "postgresql+psycopg://melostream:Mame33@localhost:5432/melostream"
    REDIS_URL: str = "redis://localhost:6379/2"
    JWT_SECRET_KEY: SecretStr | None = None
    SOCIAL_COOKIE_ENCRYPTION_KEY: SecretStr | None = None
    BURNER_YOUTUBE_COOKIES: str | None = None
    BURNER_TIKTOK_COOKIES: str | None = None
    BURNER_YOUTUBE_COOKIES_FILE: str | None = None
    BURNER_TIKTOK_COOKIES_FILE: str | None = None
    ACCESS_TOKEN_MINUTES: int = 15
    REFRESH_TOKEN_DAYS: int = 30
    AUTH_COOKIE_SECURE: bool = False
    AUTH_COOKIE_SAMESITE: Literal["lax", "strict", "none"] = "lax"
    CORS_ORIGINS: str = ""

    # Storage allocation directories
    BASE_DIR: str = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    DOWNLOAD_DIR: str = os.path.join(BASE_DIR, "storage", "downloads")
    TEMP_DIR: str = os.path.join(BASE_DIR, "storage", "temp")

    # Rate limiting configuration
    RATE_LIMIT_MAX_TOKENS: int = 5
    RATE_LIMIT_REFILL_INTERVAL: int = 30  # Refill 1 token every 30 seconds

settings = Settings()

# Ensure directories exist physically on boot
os.makedirs(settings.DOWNLOAD_DIR, exist_ok=True)
os.makedirs(settings.TEMP_DIR, exist_ok=True)