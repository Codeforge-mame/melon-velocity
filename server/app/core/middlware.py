import time
import json
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from app.core.config import settings

class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app):
        super().__init__(app)
        self.buckets = {}

    async def dispatch(self, request: Request, call_next):
        # Only rate-limit API V1 endpoints
        if not request.url.path.startswith(settings.API_V1_STR):
            return await call_next(request)

        client_ip = request.client.host if request.client else "global-client"
        now = time.time()

        if client_ip not in self.buckets:
            self.buckets[client_ip] = {"tokens": settings.RATE_LIMIT_MAX_TOKENS, "last_refill": now}

        bucket = self.buckets[client_ip]
        elapsed = now - bucket["last_refill"]
        
        tokens_to_add = int(elapsed / settings.RATE_LIMIT_REFILL_INTERVAL)
        if tokens_to_add > 0:
            bucket["tokens"] = min(settings.RATE_LIMIT_MAX_TOKENS, bucket["tokens"] + tokens_to_add)
            bucket["last_refill"] = now - (elapsed % settings.RATE_LIMIT_REFILL_INTERVAL)

        if bucket["tokens"] <= 0:
            retry_after = int(settings.RATE_LIMIT_REFILL_INTERVAL - (now - bucket["last_refill"]))
            return Response(
                content=json.dumps({"error": f"Rate limit reached. Retry after {retry_after} seconds."}),
                status_code=429,
                media_type="application/json",
                headers={"Retry-After": str(retry_after)}
            )

        bucket["tokens"] -= 1
        response = await call_next(request)
        response.headers["X-RateLimit-Remaining"] = str(bucket["tokens"])
        return response