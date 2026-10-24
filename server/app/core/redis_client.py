import json
import logging
from typing import Any

import redis.asyncio as redis
from redis.asyncio import Redis

from app.core.config import settings

logger = logging.getLogger(__name__)


class RedisClient:
    """Async Redis client wrapper with connection pooling."""

    def __init__(self):
        self._client: Redis | None = None

    async def get_client(self) -> Redis:
        """Get or create Redis client."""
        if self._client is None:
            self._client = await redis.from_url(
                settings.redis_url,
                encoding="utf-8",
                decode_responses=True,
            )
        return self._client

    async def close(self):
        """Close Redis connection."""
        if self._client:
            await self._client.close()
            self._client = None

    async def get(self, key: str) -> str | None:
        """Get a value from Redis."""
        client = await self.get_client()
        try:
            return await client.get(key)
        except Exception as e:
            logger.error(f"Redis GET error for key {key}: {e}")
            return None

    async def set(self, key: str, value: str, ttl: int | None = None) -> bool:
        """Set a value in Redis with optional TTL."""
        client = await self.get_client()
        try:
            if ttl:
                return await client.setex(key, ttl, value)
            return await client.set(key, value)
        except Exception as e:
            logger.error(f"Redis SET error for key {key}: {e}")
            return False

    async def delete(self, key: str) -> bool:
        """Delete a key from Redis."""
        client = await self.get_client()
        try:
            return await client.delete(key) > 0
        except Exception as e:
            logger.error(f"Redis DELETE error for key {key}: {e}")
            return False

    async def get_json(self, key: str) -> Any | None:
        """Get a JSON value from Redis."""
        value = await self.get(key)
        if value:
            try:
                return json.loads(value)
            except json.JSONDecodeError as e:
                logger.error(f"JSON decode error for key {key}: {e}")
        return None

    async def set_json(self, key: str, value: Any, ttl: int | None = None) -> bool:
        """Set a JSON value in Redis with optional TTL."""
        try:
            json_value = json.dumps(value)
        except (TypeError, ValueError) as e:
            logger.error(f"JSON encode error for key {key}: {e}")
            return False
        return await self.set(key, json_value, ttl)

    async def increment(self, key: str) -> int:
        """Increment a counter in Redis."""
        client = await self.get_client()
        try:
            return await client.incr(key)
        except Exception as e:
            logger.error(f"Redis INCR error for key {key}: {e}")
            return 0

    async def expire(self, key: str, ttl: int) -> bool:
        """Set expiration time for a key."""
        client = await self.get_client()
        try:
            return await client.expire(key, ttl)
        except Exception as e:
            logger.error(f"Redis EXPIRE error for key {key}: {e}")
            return False

    async def exists(self, key: str) -> bool:
        """Check if a key exists."""
        client = await self.get_client()
        try:
            return await client.exists(key) > 0
        except Exception as e:
            logger.error(f"Redis EXISTS error for key {key}: {e}")
            return False


# Global Redis client instance
redis_client = RedisClient()
