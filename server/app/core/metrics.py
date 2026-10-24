import logging
from prometheus_client import Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST
from fastapi import Response

logger = logging.getLogger(__name__)

# Request metrics
request_total = Counter(
    'http_requests_total',
    'Total HTTP requests',
    ['method', 'endpoint', 'status']
)

request_duration = Histogram(
    'http_request_duration_seconds',
    'HTTP request duration',
    ['method', 'endpoint']
)

# Resolution metrics
resolution_total = Counter(
    'video_resolutions_total',
    'Total video resolutions',
    ['status']
)

resolution_duration = Histogram(
    'video_resolution_duration_seconds',
    'Video resolution duration'
)

# Cache metrics
cache_hits = Counter(
    'cache_hits_total',
    'Total cache hits'
)

cache_misses = Counter(
    'cache_misses_total',
    'Total cache misses'
)

# Rate limit metrics
rate_limit_blocks = Counter(
    'rate_limit_blocks_total',
    'Total rate limit blocks',
    ['type']  # installation or ip
)

# Active resolutions
active_resolutions = Gauge(
    'active_resolutions',
    'Currently active video resolutions'
)


async def metrics_endpoint() -> Response:
    """Prometheus metrics endpoint."""
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST
    )
