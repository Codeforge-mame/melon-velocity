# MeloStream server

## Run the API, Redis, and Celery worker

From this directory, run:

```sh
docker compose up --build
```

The API is available on port `8000`. The worker and API share `app/storage`
for completed videos and temporary extraction data. Downloads are queued by
`POST /api/v1/download`; poll `GET /api/v1/download/{task_id}` until the task
reports `success`, then fetch the returned name from `/api/v1/stream/{fileName}`.

For authenticated extraction, place a yt-dlp Netscape-format cookie file at
`app/storage/cookies.txt`, or set `YTDLP_COOKIE_FILE` to its container path.
Cookie files are runtime secrets and must not be committed.