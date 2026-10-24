import logging
import time

from app.core.config import settings
from app.core.redis_client import redis_client

logger = logging.getLogger(__name__)


class RateLimiter:
    """
    Redis-based distributed rate limiter for API requests.

    Limits are per-client (installation ID) and per-IP.
    Limits are shared across multiple server instances via Redis.
    """

    def __init__(self):
        self._window_seconds = settings.rate_limit_window_seconds
        self._max_requests = settings.rate_limit_requests

    async def check_rate_limit(
        self, client_id: str | None = None, ip_address: str | None = None
    ) -> tuple[bool, int | None]:
        """
        Check if a request is within rate limits.

        Args:
            client_id: Installation ID from X-Installation-ID header
            ip_address: Client IP address

        Returns:
            Tuple of (allowed, retry_after_seconds)
            retry_after_seconds is None if request is allowed
        """
        now = time.time()
        identifiers = []

        if client_id:
            identifiers.append(f"rate_limit:installation:{client_id}")
        if ip_address:
            identifiers.append(f"rate_limit:ip:{ip_address}")

        if not identifiers:
            # If no identifiers, allow the request but log warning
            logger.warning("Rate limit check with no identifiers")
            return True, None

        for identifier in identifiers:
            # Get current count
            count = await redis_client.get(identifier)
            current_count = int(count) if count else 0

            if current_count >= self._max_requests:
                # Rate limit exceeded, calculate retry after
                ttl = await redis_client.get_client()
                ttl_val = await ttl.ttl(identifier)
                return False, ttl_val if ttl_val > 0 else self._window_seconds

        # Increment counters for all identifiers
        for identifier in identifiers:
            new_count = await redis_client.increment(identifier)
            if new_count == 1:
                # First request, set expiration
                await redis_client.expire(identifier, self._window_seconds)

        return True, None

    async def reset(self, client_id: str | None = None, ip_address: str | None = None) -> None:
        """
        Reset rate limits for specific identifiers (useful for testing).
        If no identifiers provided, clears all rate limit keys.
        """
        if client_id:
            await redis_client.delete(f"rate_limit:installation:{client_id}")
        if ip_address:
            await redis_client.delete(f"rate_limit:ip:{ip_address}")

        if not client_id and not ip_address:
            # Clear all rate limit keys
            client = await redis_client.get_client()
            pattern = "rate_limit:*"
            keys = []
            async for key in client.scan_iter(match=pattern):
                keys.append(key)
            if keys:
                await client.delete(*keys)


# Global rate limiter instance
rate_limiter = RateLimiter()
