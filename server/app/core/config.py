from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application configuration loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_env: str = "development"
    log_level: str = "INFO"

    # yt-dlp extraction settings
    resolve_timeout_seconds: int = 25
    max_concurrent_resolves: int = 1

    # Rate limiting settings
    rate_limit_requests: int = 10
    rate_limit_window_seconds: int = 600  # 10 minutes

    # Installation ID validation
    installation_id_min_length: int = 16
    installation_id_max_length: int = 128

    # Redis settings
    redis_url: str = "redis://localhost:6379/0"
    cache_ttl_seconds: int = 3600  # 1 hour

    # Database settings
    database_url: str = "sqlite:///./app.db"

    # API authentication
    jwt_secret_key: str = "change-this-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expiration_hours: int = 24

    # Request queue
    queue_max_size: int = 100

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"

    @property
    def is_development(self) -> bool:
        return self.app_env.lower() == "development"


settings = Settings()
