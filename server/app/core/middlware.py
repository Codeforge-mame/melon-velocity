import hashlib
import json
import logging
import uuid

from fastapi import Request, Response
from redis.exceptions import RedisError
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.config import settings

logger = logging.getLogger(__name__)

DOWNLOAD_STATUS_CAPACITY = 120
DOWNLOAD_STATUS_REFILL_SECONDS = 2

TOKEN_BUCKET_SCRIPT = """
local capacity = tonumber(ARGV[1])
local refill_interval_ms = tonumber(ARGV[2])
local now = redis.call('TIME')
local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens'))
local last_refill_ms = tonumber(redis.call('HGET', KEYS[1], 'last_refill_ms'))

if not tokens or not last_refill_ms then
    tokens = capacity
    last_refill_ms = now_ms
else
    local elapsed_ms = math.max(0, now_ms - last_refill_ms)
    local tokens_to_add = math.floor(elapsed_ms / refill_interval_ms)
    if tokens_to_add > 0 then
        tokens = math.min(capacity, tokens + tokens_to_add)
        last_refill_ms = last_refill_ms + tokens_to_add * refill_interval_ms
    end
end

local allowed = 0
local retry_after = 0
if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
else
    retry_after = math.max(1, math.ceil((refill_interval_ms - (now_ms - last_refill_ms)) / 1000))
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'last_refill_ms', last_refill_ms)
redis.call('EXPIRE', KEYS[1], math.ceil(capacity * refill_interval_ms * 2 / 1000))
return {allowed, tokens, retry_after}
"""


def _rate_limit_bucket(request: Request) -> tuple[str, int, int]:
    path_parts = request.url.path.removeprefix(f"{settings.API_V1_STR}/").split("/")
    is_download_status_poll = (
        request.method == "GET"
        and len(path_parts) == 2
        and path_parts[0] == "download"
        and path_parts[1] != "direct"
    )
    if is_download_status_poll:
        try:
            uuid.UUID(path_parts[1])
        except ValueError:
            is_download_status_poll = False

    if is_download_status_poll:
        return "download-status", DOWNLOAD_STATUS_CAPACITY, DOWNLOAD_STATUS_REFILL_SECONDS
    return "default", settings.RATE_LIMIT_MAX_TOKENS, settings.RATE_LIMIT_REFILL_INTERVAL


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not request.url.path.startswith(settings.API_V1_STR):
            return await call_next(request)

        client_ip = request.client.host if request.client else "global-client"
        ip_hash = hashlib.sha256(client_ip.encode("utf-8")).hexdigest()
        bucket_name, capacity, refill_interval = _rate_limit_bucket(request)
        redis_client = getattr(request.app.state, "rate_limit_redis", None)
        if redis_client is None:
            logger.error("Rate limiting is unavailable because Redis is not initialized.")
            return Response(
                content=json.dumps({"detail": "The rate-limit service is unavailable."}),
                status_code=503,
                media_type="application/json",
            )

        try:
            allowed, remaining, retry_after = await redis_client.eval(
                TOKEN_BUCKET_SCRIPT,
                1,
                f"melostream:rate-limit:{bucket_name}:{ip_hash}",
                capacity,
                refill_interval * 1000,
            )
        except RedisError:
            logger.exception("Redis-backed request rate limiting failed.")
            return Response(
                content=json.dumps({"detail": "The rate-limit service is unavailable."}),
                status_code=503,
                media_type="application/json",
            )

        if not int(allowed):
            return Response(
                content=json.dumps(
                    {
                        "detail": (
                            f"Rate limit reached. Retry after {int(retry_after)} seconds."
                        )
                    }
                ),
                status_code=429,
                media_type="application/json",
                headers={
                    "Retry-After": str(int(retry_after)),
                    "X-RateLimit-Limit": str(capacity),
                    "X-RateLimit-Remaining": "0",
                },
            )

        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(capacity)
        response.headers["X-RateLimit-Remaining"] = str(int(remaining))
        return response
