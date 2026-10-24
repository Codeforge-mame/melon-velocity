import hashlib
import logging
from typing import Any

from app.core.config import settings
from app.core.redis_client import redis_client
from app.schema.video import ResolveResponse

logger = logging.getLogger(__name__)


class CacheService:
    """Redis-based caching service for video resolution results."""

    def _generate_cache_key(self, url: str) -> str:
        """Generate a cache key from URL."""
        return f"video:{hashlib.sha256(url.encode()).hexdigest()}"

    async def get(self, url: str) -> ResolveResponse | None:
        """Get cached video resolution result."""
        key = self._generate_cache_key(url)
        cached = await redis_client.get_json(key)
        
        if cached:
            logger.info(f"Cache hit for URL: {url}")
            try:
                return ResolveResponse(**cached)
            except Exception as e:
                logger.error(f"Failed to deserialize cached data: {e}")
                await redis_client.delete(key)
        return None

    async def set(self, url: str, response: ResolveResponse) -> bool:
        """Cache video resolution result."""
        key = self._generate_cache_key(url)
        try:
            return await redis_client.set_json(
                key,
                response.model_dump(),
                ttl=settings.cache_ttl_seconds,
            )
        except Exception as e:
            logger.error(f"Failed to cache result: {e}")
            return False

    async def invalidate(self, url: str) -> bool:
        """Invalidate cached result for a URL."""
        key = self._generate_cache_key(url)
        return await redis_client.delete(key)

    async def clear_all(self) -> bool:
        """Clear all video cache entries."""
        client = await redis_client.get_client()
        try:
            pattern = "video:*"
            keys = []
            async for key in client.scan_iter(match=pattern):
                keys.append(key)
            if keys:
                await client.delete(*keys)
            logger.info(f"Cleared {len(keys)} cache entries")
            return True
        except Exception as e:
            logger.error(f"Failed to clear cache: {e}")
            return False


# Global cache service instance
cache_service = CacheService()
