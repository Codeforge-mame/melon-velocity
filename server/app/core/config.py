import os
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    PROJECT_NAME: str = "MeloStream Engine Backend"
    API_V1_STR: str = "/api/v1"
    
    # Storage allocation directories
    BASE_DIR: str = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    DOWNLOAD_DIR: str = os.path.join(BASE_DIR, "storage", "downloads")
    TEMP_DIR: str = os.path.join(BASE_DIR, "storage", "temp")
    YTDLP_COOKIE_FILE: str = os.path.join(BASE_DIR, "storage", "cookies.txt")

    # Rate limiting configuration
    RATE_LIMIT_MAX_TOKENS: int = 5
    RATE_LIMIT_REFILL_INTERVAL: int = 30  # Refill 1 token every 30 seconds

    class Config:
        case_sensitive = True

settings = Settings()

# Ensure directories exist physically on boot
os.makedirs(settings.DOWNLOAD_DIR, exist_ok=True)
os.makedirs(settings.TEMP_DIR, exist_ok=True)