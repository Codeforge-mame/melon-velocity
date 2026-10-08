import os
import tempfile
import time
import unittest
import uuid
from collections.abc import Iterator

from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jose import jwt
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from pydantic import SecretStr
from unittest.mock import Mock, patch
from redis.exceptions import RedisError

from app.api.auth import get_redis, router as auth_router
from app.api.routes import router as video_router
from app.core.celery_app import celery_app
from app.core.config import settings
from app.core.middlware import RateLimitMiddleware
from app.db import Base, get_db
from app.models import User, UserSocialAccount
from app.security import verify_password
from app.services.extractore import VideoExtractorService
from app.services.social_sessions import temporary_cookie_file
from app.services.tasks import build_download_options, download_video_task


class InMemoryRedis:
    def __init__(self) -> None:
        self.values: dict[str, bytes] = {}

    def setex(self, key: str, _seconds: int, value: str) -> None:
        self.values[key] = value.encode("utf-8")

    def getdel(self, key: str) -> bytes | None:
        return self.values.pop(key, None)

    def get(self, key: str) -> bytes | None:
        return self.values.get(key)

    def delete(self, key: str) -> None:
        self.values.pop(key, None)

    def close(self) -> None:
        return


class InMemoryRateLimitRedis:
    def __init__(self) -> None:
        self.buckets: dict[str, tuple[float, float]] = {}

    async def eval(
        self,
        _script: str,
        _key_count: int,
        key: str,
        capacity: int,
        refill_interval_ms: int,
    ) -> list[int]:
        now = time.monotonic()
        tokens, last_refill = self.buckets.get(key, (float(capacity), now))
        elapsed_ms = max(0, int((now - last_refill) * 1000))
        added = elapsed_ms // refill_interval_ms
        if added:
            tokens = min(float(capacity), tokens + added)
            last_refill += added * refill_interval_ms / 1000
        if tokens >= 1:
            tokens -= 1
            allowed = 1
            retry_after = 0
        else:
            allowed = 0
            retry_after = max(
                1,
                int((refill_interval_ms - (now - last_refill) * 1000 + 999) // 1000),
            )
        self.buckets[key] = (tokens, last_refill)
        return [allowed, int(tokens), retry_after]


class FailedRateLimitRedis:
    async def eval(self, *_args: object) -> list[int]:
        raise RedisError("Redis is unavailable.")


class RateLimitMiddlewareTests(unittest.TestCase):
    def test_status_polling_has_separate_budget_from_regular_api_requests(self) -> None:
        app = FastAPI()
        app.add_middleware(RateLimitMiddleware)
        app.state.rate_limit_redis = InMemoryRateLimitRedis()

        @app.get("/api/v1/download/{task_id}")
        def download_status(task_id: str) -> dict[str, str]:
            return {"status": "queued"}

        @app.get("/api/v1/info")
        def video_info() -> dict[str, str]:
            return {"status": "ok"}

        task_id = "00000000-0000-0000-0000-000000000000"
        with TestClient(app) as client:
            for _ in range(10):
                self.assertEqual(client.get(f"/api/v1/download/{task_id}").status_code, 200)
            for _ in range(settings.RATE_LIMIT_MAX_TOKENS):
                self.assertEqual(client.get("/api/v1/info").status_code, 200)
            rate_limited = client.get("/api/v1/info")
            self.assertEqual(rate_limited.status_code, 429)
            self.assertIn("detail", rate_limited.json())

    def test_requests_fail_closed_when_redis_is_unavailable(self) -> None:
        app = FastAPI()
        app.add_middleware(RateLimitMiddleware)
        app.state.rate_limit_redis = FailedRateLimitRedis()

        @app.get("/api/v1/info")
        def video_info() -> dict[str, str]:
            return {"status": "ok"}

        with TestClient(app) as client:
            response = client.get("/api/v1/info")
        self.assertEqual(response.status_code, 503)
        self.assertIn("unavailable", response.json()["detail"])


class AccountFeatureTests(unittest.TestCase):
    def test_download_worker_limits_media_processing_to_two_tasks(self) -> None:
        self.assertEqual(celery_app.conf.worker_concurrency, 2)
        self.assertEqual(celery_app.conf.worker_prefetch_multiplier, 1)

    def test_media_download_uses_five_megabyte_sequential_chunks_with_backoff(self) -> None:
        options = build_download_options("18", "sample", "/tmp/melostream-task")
        self.assertEqual(options["http_chunk_size"], 5 * 1024 * 1024)
        self.assertEqual(options["concurrent_fragment_downloads"], 1)
        self.assertEqual(options["retries"], 5)
        self.assertEqual(options["retry_sleep_functions"]["http"](1), 1)
        self.assertEqual(options["retry_sleep_functions"]["http"](5), 16)
        self.assertEqual(options["retry_sleep_functions"]["http"](10), 30)

    def test_worker_stops_queued_cancelled_download_before_processing(self) -> None:
        with tempfile.TemporaryDirectory() as task_root:
            previous_download_dir = settings.DOWNLOAD_DIR
            previous_temp_dir = settings.TEMP_DIR
            settings.DOWNLOAD_DIR = os.path.join(task_root, "downloads")
            settings.TEMP_DIR = os.path.join(task_root, "temp")
            os.makedirs(settings.DOWNLOAD_DIR)
            cancel_redis = Mock()
            cancel_redis.exists.return_value = 1
            try:
                with (
                    patch("app.services.tasks.Redis.from_url", return_value=cancel_redis),
                    patch("app.services.tasks.yt_dlp.YoutubeDL") as youtube_dl,
                ):
                    result = download_video_task.run(
                        "https://www.facebook.com/watch/sample",
                        "18",
                        "cancelled-task",
                    )
                self.assertEqual(result["status"], "cancelled")
                youtube_dl.assert_not_called()
                self.assertEqual(os.listdir(settings.DOWNLOAD_DIR), [])
                self.assertEqual(os.listdir(settings.TEMP_DIR), [])
            finally:
                settings.DOWNLOAD_DIR = previous_download_dir
                settings.TEMP_DIR = previous_temp_dir

    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.redis = InMemoryRedis()
        settings.JWT_SECRET_KEY = SecretStr("test-only-signing-secret")
        settings.SOCIAL_COOKIE_ENCRYPTION_KEY = SecretStr(
            Fernet.generate_key().decode("ascii")
        )

        self.app = FastAPI()
        self.app.include_router(video_router, prefix="/api/v1")
        self.app.include_router(auth_router, prefix="/api/v1/auth")

        def test_db() -> Iterator[Session]:
            with Session(self.engine, expire_on_commit=False) as session:
                yield session

        self.app.dependency_overrides[get_db] = test_db
        self.app.dependency_overrides[get_redis] = lambda: self.redis
        self.client = TestClient(self.app)

    def tearDown(self) -> None:
        self.client.close()
        self.engine.dispose()
        self.app.dependency_overrides.clear()

    def create_user(self) -> tuple[str, str]:
        email = "person@example.com"
        password = "long-enough-password"
        response = self.client.post(
            "/api/v1/auth/signup",
            json={"email": email, "password": password},
        )
        self.assertEqual(response.status_code, 201)
        with Session(self.engine) as session:
            user = session.scalar(select(User).where(User.email == email))
            self.assertIsNotNone(user)
            self.assertNotEqual(user.password_hash, password)
            self.assertTrue(verify_password(password, user.password_hash))
        return email, password

    def test_signup_oauth_login_and_cookie_refresh_rotation(self) -> None:
        email, password = self.create_user()
        login = self.client.post(
            "/api/v1/auth/token",
            data={"username": email, "password": password},
        )
        self.assertEqual(login.status_code, 200)
        access_token = login.json()["access_token"]
        first_refresh_token = self.client.cookies.get("refresh_token")
        self.assertTrue(first_refresh_token)
        claims = jwt.get_unverified_claims(first_refresh_token)
        self.assertEqual(claims["type"], "refresh")
        me = self.client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        self.assertEqual(me.json()["email"], email)

        refreshed = self.client.post("/api/v1/auth/refresh")
        self.assertEqual(refreshed.status_code, 200)
        self.assertNotEqual(self.client.cookies.get("refresh_token"), first_refresh_token)

    def test_supported_urls_require_matching_logged_in_platform_mode(self) -> None:
        unauthenticated = self.client.post(
            "/api/v1/info",
            json={"url": "https://www.youtube.com/watch?v=sample", "mode": "youtube"},
        )
        self.assertEqual(unauthenticated.status_code, 401)
        self.assertEqual(
            unauthenticated.json()["detail"],
            "Please log in to download this video",
        )
        download = self.client.post(
            "/api/v1/download",
            json={
                "url": "https://www.youtube.com/watch?v=sample",
                "format_id": "18",
                "resolution": "360p",
                "mode": "default",
            },
        )
        self.assertEqual(download.status_code, 401)
        self.assertEqual(
            download.json()["detail"],
            "Please log in to download this video",
        )

        email, password = self.create_user()
        login = self.client.post(
            "/api/v1/auth/token",
            data={"username": email, "password": password},
        )
        access_token = login.json()["access_token"]
        headers = {"Authorization": f"Bearer {access_token}"}
        default_mode = self.client.post(
            "/api/v1/info",
            json={"url": "https://www.youtube.com/watch?v=sample", "mode": "default"},
            headers=headers,
        )
        self.assertEqual(default_mode.status_code, 401)
        self.assertEqual(
            default_mode.json()["detail"],
            "Please log in to download this video",
        )
        default_download = self.client.post(
            "/api/v1/download",
            json={
                "url": "https://www.youtube.com/watch?v=sample",
                "format_id": "18",
                "resolution": "360p",
                "mode": "default",
            },
            headers=headers,
        )
        self.assertEqual(default_download.status_code, 401)
        self.assertEqual(
            default_download.json()["detail"],
            "Please log in to download this video",
        )

    def test_queued_download_cancellation_requires_its_signed_token(self) -> None:
        task_id = str(uuid.uuid4())
        queued_task = Mock(id=task_id)
        payload = {
            "url": "https://www.facebook.com/watch/sample",
            "format_id": "18",
            "resolution": "360p",
            "mode": "default",
        }
        with patch(
            "app.api.routes.download_video_task.apply_async",
            return_value=queued_task,
        ):
            queued = self.client.post("/api/v1/download", json=payload)
        self.assertEqual(queued.status_code, 202)
        token = queued.json()["cancellationToken"]

        with (
            patch("app.api.routes.Redis.from_url", return_value=self.redis),
            patch("app.api.routes.celery_app.AsyncResult", return_value=Mock(state="PENDING")),
        ):
            denied = self.client.post(
                f"/api/v1/download/{task_id}/cancel",
                json={"cancellationToken": f"{token}invalid"},
            )
            self.assertEqual(denied.status_code, 404)
            self.assertNotIn(f"melostream:download-cancel:{task_id}", self.redis.values)

            cancelled = self.client.post(
                f"/api/v1/download/{task_id}/cancel",
                json={"cancellationToken": token},
            )

        self.assertEqual(cancelled.status_code, 200)
        self.assertEqual(cancelled.json()["status"], "cancelling")
        self.assertEqual(
            self.redis.values[f"melostream:download-cancel:{task_id}"],
            b"1",
        )

        with tempfile.TemporaryDirectory() as download_dir:
            previous_download_dir = settings.DOWNLOAD_DIR
            settings.DOWNLOAD_DIR = download_dir
            file_name = f"melo_{uuid.uuid4()}.mp4"
            file_path = os.path.join(download_dir, file_name)
            with open(file_path, "wb") as video_file:
                video_file.write(b"unused output")
            try:
                with patch(
                    "app.api.routes.celery_app.AsyncResult",
                    return_value=Mock(
                        state="SUCCESS",
                        result={"userId": None, "fileName": file_name},
                    ),
                ):
                    completed_cancel = self.client.post(
                        f"/api/v1/download/{task_id}/cancel",
                        json={"cancellationToken": token},
                    )
                self.assertEqual(completed_cancel.status_code, 200)
                self.assertEqual(completed_cancel.json()["status"], "cancelled")
                self.assertFalse(os.path.exists(file_path))
            finally:
                settings.DOWNLOAD_DIR = previous_download_dir

    def test_social_cookies_are_encrypted_and_temporary_file_is_removed(self) -> None:
        email, password = self.create_user()
        login = self.client.post(
            "/api/v1/auth/token",
            data={"username": email, "password": password},
        )
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        cookie_text = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret\n"
        saved = self.client.put(
            "/api/v1/auth/social-accounts/youtube",
            headers=headers,
            json={"cookies": cookie_text},
        )
        self.assertEqual(saved.status_code, 200)

        with Session(self.engine) as session:
            user = session.scalar(select(User).where(User.email == email))
            account = session.scalar(select(UserSocialAccount))
            self.assertNotIn(cookie_text, account.encrypted_cookies)
            self.assertTrue(account.encrypted_cookies.startswith("v2:"))
            with temporary_cookie_file(session, user.id, "youtube") as cookie_path:
                self.assertTrue(os.path.isfile(cookie_path))
                with open(cookie_path, encoding="utf-8") as cookie_file:
                    self.assertEqual(cookie_file.read(), cookie_text)
            self.assertFalse(os.path.exists(cookie_path))

            legacy_encrypted = Fernet(
                settings.SOCIAL_COOKIE_ENCRYPTION_KEY.get_secret_value().encode("ascii")
            ).encrypt(cookie_text.encode("utf-8"))
            account.encrypted_cookies = legacy_encrypted.decode("ascii")
            session.commit()
            with temporary_cookie_file(session, user.id, "youtube") as cookie_path:
                with open(cookie_path, encoding="utf-8") as cookie_file:
                    self.assertEqual(cookie_file.read(), cookie_text)

    def test_platform_detection_uses_url_hostname(self) -> None:
        self.assertEqual(
            VideoExtractorService.platform_for_url("https://youtu.be/video"),
            "youtube",
        )
        self.assertEqual(
            VideoExtractorService.platform_for_url("https://vm.tiktok.com/video"),
            "tiktok",
        )
        self.assertEqual(
            VideoExtractorService.platform_for_url("https://t.me/channel"),
            "telegram",
        )
        self.assertIsNone(
            VideoExtractorService.platform_for_url("https://youtube.com.example.org/video")
        )

    def test_private_server_download_stream_is_limited_to_its_owner(self) -> None:
        email, password = self.create_user()
        login = self.client.post(
            "/api/v1/auth/token",
            data={"username": email, "password": password},
        )
        access_token = login.json()["access_token"]
        user_id = login.json()["user"]["id"]
        file_name = f"melo_{user_id}_{uuid.uuid4()}.mp4"

        with tempfile.TemporaryDirectory() as download_dir:
            previous_download_dir = settings.DOWNLOAD_DIR
            settings.DOWNLOAD_DIR = download_dir
            try:
                file_path = os.path.join(download_dir, file_name)
                with open(file_path, "wb") as video_file:
                    video_file.write(b"private video bytes")
                with TestClient(self.app) as anonymous_client:
                    denied = anonymous_client.get(f"/api/v1/stream/{file_name}")
                self.assertEqual(denied.status_code, 404)

                async def immediate_cleanup(path: str, _delay_seconds: int = 120) -> None:
                    os.remove(path)

                with patch("app.api.routes.delayed_cleanup", immediate_cleanup):
                    allowed = self.client.get(
                        f"/api/v1/stream/{file_name}",
                        headers={"Authorization": f"Bearer {access_token}"},
                    )
                self.assertEqual(allowed.status_code, 200)
                self.assertEqual(allowed.content, b"private video bytes")
                self.assertFalse(os.path.exists(file_path))
            finally:
                settings.DOWNLOAD_DIR = previous_download_dir

    def test_authenticated_direct_download_uses_the_bounded_worker_queue(self) -> None:
        email, password = self.create_user()
        login = self.client.post(
            "/api/v1/auth/token",
            data={"username": email, "password": password},
        )
        user_id = login.json()["user"]["id"]
        access_token = login.json()["access_token"]
        download_id = uuid.uuid4()
        file_id = f"{user_id}_{download_id}"
        file_name = f"melo_{file_id}.mp4"
        fake_task = Mock()
        fake_task.get.return_value = {"userId": user_id, "fileName": file_name}

        with tempfile.TemporaryDirectory() as download_dir:
            previous_download_dir = settings.DOWNLOAD_DIR
            settings.DOWNLOAD_DIR = download_dir
            try:
                with open(os.path.join(download_dir, file_name), "wb") as video_file:
                    video_file.write(b"authenticated video bytes")

                async def immediate_cleanup(path: str, _delay_seconds: int = 120) -> None:
                    os.remove(path)

                with (
                    patch(
                        "app.api.routes.download_video_task.apply_async",
                        return_value=fake_task,
                    ) as enqueue_task,
                    patch("app.api.routes.delayed_cleanup", immediate_cleanup),
                    patch("app.api.routes.uuid.uuid4", return_value=download_id),
                ):
                    response = self.client.get(
                        "/api/v1/download/direct",
                        params={
                            "url": "https://www.youtube.com/watch?v=sample",
                            "format_id": "18",
                            "mode": "youtube",
                        },
                        headers={"Authorization": f"Bearer {access_token}"},
                    )

                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.content, b"authenticated video bytes")
                enqueue_task.assert_called_once_with(
                    args=[
                        "https://www.youtube.com/watch?v=sample",
                        "18",
                        file_id,
                        user_id,
                    ]
                )
            finally:
                settings.DOWNLOAD_DIR = previous_download_dir


if __name__ == "__main__":
    unittest.main()
