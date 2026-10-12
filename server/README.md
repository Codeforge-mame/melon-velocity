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
`postgres_data` Compose volume. The API and worker share `app/storage` for
completed video files and temporary extraction data. Compose does not run database migrations automatically. To apply the checked-in
migration manually, run this from the `server` directory:

```sh
docker compose run --rm api uv run --no-sync alembic upgrade head
```

This runs Alembic in the API container, where the Compose database hostname
`postgres` resolves correctly. The migration is already checked in at
`migrations/versions/20261007_01_create_user_accounts.py`; do not create another
initial revision with `alembic revision --autogenerate`.

To run Alembic directly from the host instead, PostgreSQL must be published to
the host and `DATABASE_URL` must use `localhost` (not the Compose-only hostname
`postgres`), for example:
`postgresql+psycopg://melostream:<password>@localhost:5432/melostream`.

### Existing PostgreSQL volume password mismatch

`POSTGRES_PASSWORD` only initializes a new PostgreSQL data directory. Changing
it in `.env` does not change the password stored in an existing
`postgres_data` volume. Connect to PostgreSQL's always-present maintenance
database (not `melostream`, which may not exist yet) and inspect the existing
databases and roles:

```sh
docker compose exec -u postgres postgres psql -d postgres
```

At the `psql` prompt, run:

```text
\l
\du
```

If the `melostream` role exists, reset its password with `\password melostream`
and enter the new password twice. If it does not exist, create the role first:

```sql
CREATE ROLE melostream WITH LOGIN;
\password melostream
```

Enter the new password twice when prompted. Avoid putting the password directly
in the SQL command, where it can be saved in shell or database logs.

If `melostream` is not listed in `\l`, create it after creating the role and
confirming the existing database list does not contain the app's existing data:

```sql
CREATE DATABASE melostream OWNER melostream;
```

Exit with `\q`. Set `POSTGRES_PASSWORD` in `.env` to the role password and
ensure `DATABASE_URL` uses the same password. Then retry:

```sh
docker compose run --rm api uv run --no-sync alembic upgrade head
```

If an existing database has your app data under a different name, do not create
a new empty database or remove the PostgreSQL volume. Instead, point
`DATABASE_URL` at that existing database (and ensure its role has the password
configured in `.env`). Do not remove the PostgreSQL volume to fix a password
mismatch; removing it deletes the database contents.

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

New social-cookie values use versioned AES-256-GCM encryption with a random
nonce and authenticated ciphertext. Existing Fernet-encrypted values remain
readable and are replaced with AES-256-GCM the next time that account's social
session is updated. Keep the same `SOCIAL_COOKIE_ENCRYPTION_KEY` during the
transition.

## Download modes and routing

authenticated server worker and stream, regardless of the toggle, so the
authenticated user and detected URL platform.
The app modes are **Default**, **YouTube**, **Telegram**, and **TikTok**.
Default mode downloads supported external sites such as Facebook and Instagram
without cookies. YouTube and TikTok use the server's `BURNER_YOUTUBE_COOKIES`
and `BURNER_TIKTOK_COOKIES` environment values; no per-user social-cookie record
is needed for either platform. Set each value to Netscape-format cookie-file
contents in Render's environment settings. Treat these values as credentials.
Telegram continues to use the user's encrypted cookie session.

`POST /api/v1/info` accepts `{ "url": "...", "mode": "youtube|tiktok|telegram" }`
for those modes. `POST /api/v1/download` accepts `url`, `format_id`, `resolution`,
and `mode`, and responds with an MP4 `StreamingResponse`. The Expo client uses
`GET /api/v1/download/direct` with `url`, `format_id`, and `mode` query values
for a native resumable file transfer. Both routes use the same `asyncio.Semaphore(2)`
and yt-dlp configuration. Each download and FFmpeg mux runs under a private
`/tmp/ytdl_<UUID>/` directory. The response streams fixed 5 MiB chunks and
removes that directory in a `finally` block when streaming completes or is
interrupted.

The semaphore is process-local: keep one API instance with one Uvicorn worker
for a deployment-wide limit of two. Multiple Render instances or worker
processes each get their own two-slot semaphore, so a global cap across scaled
instances requires a distributed limiter. Existing Celery task status and
cancellation routes remain for tasks queued before this direct-stream change;
drain those tasks before retiring the worker.

yt-dlp also uses one fragment request at a time and exponential waits between
HTTP/fragment retries to reduce upstream 429 throttling. Files smaller than one
chunk are handled by yt-dlp in one request; an upstream platform may still
enforce its own rate limits.

Queued download responses include a signed, short-lived cancellation token.
Clients submit `{ "cancellationToken": "..." }` to
`POST /api/v1/download/{task_id}/cancel`; the worker
checks the shared Redis cancellation marker between yt-dlp progress callbacks
and removes partial media and temporary files before returning a cancelled
status. Generated stream files are retained for up to six hours to allow
paused native transfers to resume. Native file transfers can be paused and
resumed from the app history; the resume snapshot excludes authorization
headers, which are refreshed when the user resumes.

Provider OAuth is not used as a substitute for social session cookies. Google
OAuth/YouTube Data API authorization and TikTok Login Kit authenticate access
to provider APIs, but do not grant yt-dlp browser sessions. Telegram Login
Widget authenticates an app user but does not create an MTProto session. These
flows therefore do not enable the private-video download behavior this app
offers. The app continues to use explicitly imported, encrypted session
cookies; a provider OAuth integration should only be added alongside a real
provider API feature and configured provider credentials.

## Legacy configuration cleanup

Remove `YTDLP_COOKIE_FILE` from deployment environment settings and stop using
the old shared `app/storage/cookies.txt`. The burner cookie values replace
per-user cookies for YouTube and TikTok downloads; Telegram continues to use
the authenticated social-account endpoint. Remove any legacy global cookie
file from the host after migrating any needed account sessions.
