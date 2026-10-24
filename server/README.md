# Video Resolver API

A FastAPI + yt-dlp backend for resolving video metadata and download formats. Designed for integration with mobile applications that download media directly from source URLs.

## Architecture

The server follows a layered architecture:

- **API Layer** (`app/api/routes/`): FastAPI route handlers for health checks and video resolution
- **Schema Layer** (`app/schema/`): Pydantic models for request/response validation
- **Service Layer** (`app/services/`): Business logic for video resolution using yt-dlp
- **Core Layer** (`app/core/`): Configuration and rate limiting
- **Utils Layer** (`app/utils/`): URL validation and security utilities

### Design Principles

- **Direct-to-source downloads**: The server only extracts metadata; the mobile app downloads media directly
- **Stateless**: No persistent storage or caching of temporary media URLs
- **Rate-limited**: Per-client quotas to prevent abuse
- **Secure**: URL validation, SSRF protection, and bounded resource usage
- **Lightweight**: Optimized for Render's free tier with minimal memory/CPU footprint

## API Endpoints

### GET /health

Health check endpoint (does not count against rate limits).

**Response:**
```json
{
  "status": "ok"
}
```

**Example:**
```bash
curl http://localhost:8000/health
```

### POST /v1/videos/resolve

Resolve video metadata and available download formats.

**Headers:**
- `X-Installation-ID`: Optional client identifier for rate limiting (16-128 alphanumeric characters)

**Request:**
```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```

**Response:**
```json
{
  "sourceUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Example Video Title",
  "thumbnailUrl": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
  "durationSeconds": 213,
  "formats": [
    {
      "formatId": "137",
      "label": "1080p MP4 30fps",
      "container": "mp4",
      "fileSizeBytes": 25000000,
      "downloadUrl": "https://example.com/temporary-media-url",
      "requiresAuthorization": false
    }
  ]
}
```

**Error Response:**
```json
{
  "code": "INVALID_URL",
  "message": "URL must not contain credentials"
}
```

**Example:**
```bash
curl -X POST http://localhost:8000/v1/videos/resolve \
  -H "Content-Type: application/json" \
  -H "X-Installation-ID: abc123def456" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| INVALID_URL | 400 | URL is malformed, uses unsupported scheme, or contains credentials |
| UNSUPPORTED_SITE | 400 | Website is not supported by yt-dlp or has no downloadable formats |
| AGE_OR_ACCESS_RESTRICTION | 403 | Video requires authentication, has age restrictions, or is private |
| VIDEO_UNAVAILABLE | 404 | Video is not found or has been removed |
| SOURCE_TIMEOUT | 504 | Video source did not respond within timeout |
| EXTRACTION_FAILED | 500 | Unexpected error during metadata extraction |
| RATE_LIMITED | 429 | Rate limit exceeded (includes Retry-After header) |
| SERVER_BUSY | 503 | Server is at capacity |

## Installation

### Prerequisites

- Python 3.12 or higher
- uv package manager
- FFmpeg (for yt-dlp compatibility)

### Local Setup

1. Clone the repository:
```bash
cd server
```

2. Install dependencies:
```bash
uv sync
```

3. Create environment file:
```bash
cp .env.example .env
```

4. Start the server:
```bash
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

The API will be available at `http://127.0.0.1:8000`

Interactive API documentation: `http://127.0.0.1:8000/docs` (development only)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| APP_ENV | development | Environment: `development` or `production` |
| LOG_LEVEL | INFO | Logging level: `DEBUG`, `INFO`, `WARNING`, `ERROR` |
| RESOLVE_TIMEOUT_SECONDS | 25 | Maximum time to wait for yt-dlp extraction |
| MAX_CONCURRENT_RESOLVES | 1 | Maximum concurrent extraction operations |
| RATE_LIMIT_REQUESTS | 10 | Requests allowed per time window |
| RATE_LIMIT_WINDOW_SECONDS | 600 | Time window in seconds (10 minutes) |

## Rate Limiting

### Implementation

- **10 requests per 10 minutes** per client installation ID
- Additional IP-based abuse limit as fallback
- In-memory storage (resets on process restart)
- Not shared across multiple server instances

### Limitations

- Rate limits reset when the server process restarts
- Multiple server instances do not share rate limit state
- Installation IDs can be spoofed by clients (not authenticated)
- For production with multiple instances, consider Redis or a distributed cache

### Headers

- `X-Installation-ID`: Client-provided identifier (16-128 alphanumeric characters)
- `Retry-After`: Seconds until quota resets (returned on 429 responses)

## URL Validation & SSRF Protection

### Validation Rules

- Only HTTP and HTTPS schemes allowed
- Credentials embedded in URLs are rejected
- Localhost addresses are blocked
- Private network IPs are blocked (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- Link-local addresses are blocked (169.254.0.0/16)
- Cloud metadata endpoints are blocked (169.254.169.254, metadata.google.internal)

### SSRF Assumptions

- Checking the initial hostname does not guarantee complete SSRF protection
- yt-dlp performs its own network requests and may follow redirects
- DNS rebinding attacks are possible but mitigated by IP range blocking
- For production, consider additional network-level restrictions

### Supported Hosts

The MVP uses a permissive approach for public websites. For stricter security, implement a supported-host whitelist in `app/utils/url_validation.py`.

## yt-dlp Extraction Behavior

### What is Extracted

- Video title
- Thumbnail URL
- Duration in seconds
- Available formats with direct download URLs
- File size (if available from source)

### Format Filtering

- Only formats with both video and audio codecs are returned
- Audio-only and video-only streams are excluded
- Formats without direct download URLs are excluded
- Duplicate formats (by format_id) are removed
- Duplicate URLs are removed

### Limitations

- **No server-side downloads**: Media is not downloaded or stored
- **No FFmpeg merging**: Separate audio/video streams are not combined
- **Expiring URLs**: Some sources provide temporary URLs that expire
- **Authorization**: Some formats require headers or session state not captured
- **DRM**: DRM-protected content cannot be resolved
- **CAPTCHA**: Videos requiring CAPTCHA cannot be resolved
- **Age gates**: Age-restricted content returns 403 error

### Timeout

Default timeout is 25 seconds. Slow sources or large playlists may fail.

## Unsupported Formats

The following are not supported in this version:

- DASH/HLS manifests (requires client-side parsing)
- Separate audio/video streams (requires merging)
- Live streams (not downloadable)
- DRM-protected content
- Paywalled content
- Content requiring CAPTCHA

## Render Deployment

### Prerequisites

- Render account (free tier)
- Git repository with this code

### Deployment Steps

1. **Push code to Git repository**

2. **Create new Web Service on Render:**
   - Connect your Git repository
   - Select the `server` directory as root (if using monorepo)
   - Build command: Leave empty (uses Dockerfile)
   - Start command: Leave empty (uses Dockerfile CMD)

3. **Configure Environment Variables:**
   ```
   APP_ENV=production
   LOG_LEVEL=INFO
   RESOLVE_TIMEOUT_SECONDS=25
   MAX_CONCURRENT_RESOLVES=1
   RATE_LIMIT_REQUESTS=10
   RATE_LIMIT_WINDOW_SECONDS=600
   ```

4. **Deploy:**
   - Render will build using the Dockerfile
   - The service will be available at `https://your-app.onrender.com`

### Render-Specific Notes

- Render automatically sets the `PORT` environment variable
- The Dockerfile uses `--port 8000` but Render overrides this
- Free tier has 512MB RAM limit - the server is optimized for this
- Free tier has CPU limits - concurrent resolves are limited to 1
- Free tier spins down after 15 minutes of inactivity

### Dockerfile

The Dockerfile:
- Uses Python 3.12 slim base image
- Installs FFmpeg for yt-dlp compatibility
- Uses uv for fast, reproducible dependency installation
- Excludes dev dependencies in production
- Runs Uvicorn on 0.0.0.0 for Render's proxy

## Testing

### Run Tests

```bash
# Run all tests
uv run pytest

# Run with coverage
uv run pytest --cov=app --cov-report=html

# Run specific test file
uv run pytest tests/test_health.py

# Run with verbose output
uv run pytest -v
```

### Test Coverage

- `test_health.py`: Health endpoint tests
- `test_url_validation.py`: URL validation and SSRF protection tests
- `test_rate_limit.py`: Rate limiting logic tests
- `test_resolve.py`: Resolver service tests with mocked yt-dlp data

### Linting

```bash
# Check code with ruff
uv run ruff check .

# Auto-fix issues
uv run ruff check --fix .
```

### Local Smoke Tests

```bash
# Start server
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000

# Test health endpoint
curl http://127.0.0.1:8000/health

# Test resolve endpoint (with real video URL)
curl -X POST http://127.0.0.1:8000/v1/videos/resolve \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

## Troubleshooting

### Server won't start

- Check Python version: `python --version` (must be 3.12+)
- Ensure uv is installed: `uv --version`
- Check dependencies: `uv sync`
- Verify .env file exists

### Rate limit errors

- Check `X-Installation-ID` header format (16-128 alphanumeric)
- Wait for `Retry-After` seconds before retrying
- Reset server to clear in-memory limits (development only)

### yt-dlp extraction failures

- Check if URL is publicly accessible
- Verify video is not age-restricted or private
- Try increasing `RESOLVE_TIMEOUT_SECONDS`
- Check yt-dlp logs for specific error details

### Render deployment issues

- Check Render build logs for Docker build errors
- Verify environment variables are set in Render dashboard
- Ensure Dockerfile is in repository root
- Check that PORT is not hardcoded in start command

### Memory issues on Render

- Reduce `MAX_CONCURRENT_RESOLVES` to 1 (default)
- Reduce `RESOLVE_TIMEOUT_SECONDS` if timeouts are long
- Monitor Render metrics for memory usage

## Project Structure

```
server/
├── app/
│   ├── __init__.py
│   ├── main.py                 # FastAPI application entry point
│   ├── api/
│   │   ├── __init__.py
│   │   └── routes/
│   │       ├── __init__.py
│   │       ├── health.py       # Health check endpoint
│   │       └── videos.py       # Video resolution endpoint
│   ├── schema/
│   │   ├── __init__.py
│   │   └── video.py            # Pydantic models
│   ├── services/
│   │   ├── __init__.py
│   │   └── resolver.py         # yt-dlp integration
│   ├── core/
│   │   ├── __init__.py
│   │   ├── config.py           # Configuration settings
│   │   └── rate_limit.py       # Rate limiting logic
│   └── utils/
│       ├── __init__.py
│       └── url_validation.py   # URL validation & SSRF protection
├── tests/
│   ├── __init__.py
│   ├── test_health.py
│   ├── test_url_validation.py
│   ├── test_rate_limit.py
│   └── test_resolve.py
├── .dockerignore
├── .env.example
├── .gitignore
├── Dockerfile
├── pyproject.toml
├── uv.lock
└── README.md
```

## License

[Add your license here]
