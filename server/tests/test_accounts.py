import os
import tempfile
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
from unittest.mock import patch

from app.api.auth import get_redis, router as auth_router
from app.api.routes import router as video_router
from app.core.config import settings
from app.db import Base, get_db
from app.models import User, UserSocialAccount
from app.security import verify_password
from app.services.extractore import VideoExtractorService
from app.services.social_sessions import temporary_cookie_file


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


class AccountFeatureTests(unittest.TestCase):
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
            with temporary_cookie_file(session, user.id, "youtube") as cookie_path:
                self.assertTrue(os.path.isfile(cookie_path))
                with open(cookie_path, encoding="utf-8") as cookie_file:
                    self.assertEqual(cookie_file.read(), cookie_text)
            self.assertFalse(os.path.exists(cookie_path))

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


if __name__ == "__main__":
    unittest.main()
