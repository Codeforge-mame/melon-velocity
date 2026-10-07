# MeloStream server

## Run the API, PostgreSQL, Redis, and Celery worker

Copy `.env.example` to `.env`, replace both secret placeholders with generated
values, then start the services from this directory:

```sh
cp .env.example .env
# Generate JWT_SECRET_KEY with: openssl rand -hex 32
# Generate SOCIAL_COOKIE_ENCRYPTION_KEY with:
# uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
docker compose up --build
```

The API is available on port `8000`. PostgreSQL data is persisted in the
`postgres_data` Compose volume. The `migrate` service applies Alembic revisions
before the API and worker start. The API and worker share `app/storage` for
completed video files and temporary extraction data.

For production, use distinct strong secrets, set `AUTH_COOKIE_SECURE=true`,
configure `CORS_ORIGINS` to explicit trusted web origins, and use HTTPS. If the
web client is hosted cross-site from the API, set `AUTH_COOKIE_SAMESITE=none`
along with `AUTH_COOKIE_SECURE=true`. Keep
the Fernet key stable and back it up securely; changing or losing it makes
existing encrypted social cookies unrecoverable. Do not commit `.env`.

## Database

`app/models.py` defines `User` and `UserSocialAccount`. The initial revision,
`migrations/versions/20261007_01_create_user_accounts.py`, creates:

- `users`: UUID primary key, unique email, bcrypt password hash, creation time.
- `user_social_accounts`: UUID primary key, user foreign key with cascade
  delete, platform constrained to `youtube`, `tiktok`, or `telegram`, encrypted
  Netscape-format cookies, timestamps, and one account per platform per user.

Apply migrations manually with `uv run alembic upgrade head`. To undo this
initial revision (this drops both tables and their data), use
`uv run alembic downgrade base`.

## Authentication and social sessions

- `POST /api/v1/auth/signup` accepts `{ "email": "...", "password": "..." }`.
  Passwords must be at least 10 characters and are stored as one-way bcrypt
  hashes.
- `POST /api/v1/auth/token` accepts OAuth2 password-form fields `username`
  (email) and `password`. It returns a short-lived OAuth2 bearer access token
  and sets HttpOnly access/refresh cookies.
- `POST /api/v1/auth/refresh` rotates the HttpOnly refresh cookie; the consumed
  refresh token ID is invalidated in Redis. `POST /api/v1/auth/logout` revokes
  it. `GET /api/v1/auth/me` returns the current account.
- `PUT /api/v1/auth/social-accounts/{platform}` accepts (where `platform` is
  `youtube`, `tiktok`, or `telegram`)
  `{ "cookies": "<Netscape cookie-file text>" }`. `GET` lists configured
  platforms without returning secrets; `DELETE` removes a saved session.

The encryption key is read from `SOCIAL_COOKIE_ENCRYPTION_KEY`. Decrypted
cookies are written with restrictive temporary-file permissions under `/tmp`
only for a single extraction/download and are removed as soon as yt-dlp
finishes using them.

Fernet is used as requested; it provides authenticated encryption using
AES-128-CBC and HMAC-SHA256 (Fernet does not support AES-256). If policy
requires AES-256 specifically, use an AES-256-GCM implementation instead.

## Download modes and routing

The app modes are **Default**, **YouTube**, **Telegram**, and **TikTok**.
Default mode permits public URLs such as Facebook/Instagram, but rejects
YouTube, Telegram, and TikTok URLs with `Please log in to download this video`.
For those platforms, select the matching platform mode, sign in, and save its
cookie session in Sidebar Settings. The backend checks both the selected mode
and the URL host; social cookie files and direct media URLs are not sent to the
client.

The existing **Server Boost / Phone Direct** switch remains in Sidebar
Settings. Server Boost queues work through Celery. Phone Direct downloads
public unsupported-platform media directly on the device; for private social
platform URLs, it downloads an authenticated file through the FastAPI route so
the user's cookies remain server-side. The encrypted cookies are selected by
the authenticated user and detected URL platform in both paths.

For authenticated social URLs, call `POST /api/v1/info` with `{ "url": "...",
"mode": "youtube|tiktok|telegram" }`; `POST /api/v1/download` accepts `url`,
`format_id`, and `mode`. The Phone Direct authenticated stream uses
`GET /api/v1/download/direct?url=...&format_id=...&mode=...` with a bearer
access token. Celery downloads are queued by `POST /api/v1/download`; poll
`GET /api/v1/download/{task_id}` until `success`, then fetch the returned name
from `GET /api/v1/stream/{fileName}`.

## Legacy configuration cleanup

Remove `YTDLP_COOKIE_FILE` from deployment environment settings and stop using
the old shared `app/storage/cookies.txt`. This version does not load global
yt-dlp cookies; import each user's cookies through the authenticated social
account endpoint instead. Remove any legacy global cookie file from the host
after migrating any needed account sessions.
