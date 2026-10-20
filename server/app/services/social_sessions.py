import base64
import binascii
import os
import tempfile
import uuid
from collections.abc import Iterator
from contextlib import contextmanager

from cryptography.exceptions import InvalidTag
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import SocialPlatform, UserSocialAccount


class SocialAccountMissingError(Exception):
    pass


class BurnerCookiesNotConfiguredError(Exception):
    pass


@contextmanager
def burner_cookie_file(platform: SocialPlatform) -> Iterator[str]:
    setting_prefix = f"BURNER_{platform.upper()}_COOKIES"
    configured_path = getattr(settings, f"{setting_prefix}_FILE")
    if configured_path:
        if not os.path.isfile(configured_path) or not os.access(configured_path, os.R_OK):
            raise BurnerCookiesNotConfiguredError
        yield configured_path
        return

    cookie_text = getattr(settings, setting_prefix)
    if not cookie_text:
        raise BurnerCookiesNotConfiguredError

    file_descriptor, cookie_path = tempfile.mkstemp(
        prefix=f"melostream-{platform}-cookies-", suffix=".txt"
    )
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8", newline="") as cookie_file:
            cookie_file.write(cookie_text)
        yield cookie_path
    finally:
        try:
            os.remove(cookie_path)
        except FileNotFoundError:
            pass


def _encryption_keys() -> tuple[str, bytes]:
    if not settings.SOCIAL_COOKIE_ENCRYPTION_KEY:
        raise RuntimeError(
            "SOCIAL_COOKIE_ENCRYPTION_KEY must be configured before storing or using social cookies."
        )
    encoded_key = settings.SOCIAL_COOKIE_ENCRYPTION_KEY.get_secret_value()
    try:
        key = base64.urlsafe_b64decode(encoded_key.encode("ascii"))
    except (UnicodeEncodeError, binascii.Error) as exc:
        raise RuntimeError("SOCIAL_COOKIE_ENCRYPTION_KEY must be a valid Fernet-format key.") from exc
    if len(key) != 32 or base64.urlsafe_b64encode(key).decode("ascii") != encoded_key:
        raise RuntimeError("SOCIAL_COOKIE_ENCRYPTION_KEY must decode to exactly 32 bytes.")
    return encoded_key, key


def encrypt_cookies(cookies: str) -> str:
    _, key = _encryption_keys()
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, cookies.encode("utf-8"), None)
    token = base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")
    return f"v2:{token}"


def _decrypt_cookies(encrypted_cookies: str) -> bytes:
    encoded_key, key = _encryption_keys()
    if encrypted_cookies.startswith("v2:"):
        try:
            token = base64.urlsafe_b64decode(encrypted_cookies[3:].encode("ascii"))
            if len(token) < 12 + 16:
                raise ValueError("The encrypted cookie payload is incomplete.")
            return AESGCM(key).decrypt(token[:12], token[12:], None)
        except (InvalidTag, ValueError, UnicodeEncodeError, binascii.Error) as exc:
            raise RuntimeError(
                "Saved social cookies could not be decrypted; verify SOCIAL_COOKIE_ENCRYPTION_KEY."
            ) from exc

    try:
        return Fernet(encoded_key.encode("ascii")).decrypt(encrypted_cookies.encode("ascii"))
    except (InvalidToken, UnicodeEncodeError) as exc:
        raise RuntimeError(
            "Saved social cookies could not be decrypted; verify SOCIAL_COOKIE_ENCRYPTION_KEY."
        ) from exc


@contextmanager
def temporary_cookie_file(
    session: Session, user_id: uuid.UUID, platform: SocialPlatform
) -> Iterator[str]:
    account = session.scalar(
        select(UserSocialAccount).where(
            UserSocialAccount.user_id == user_id,
            UserSocialAccount.platform == platform,
        )
    )
    if account is None:
        raise SocialAccountMissingError(
            f"No {platform} session cookies are saved for this account."
        )

    cookies = _decrypt_cookies(account.encrypted_cookies)

    file_descriptor, cookie_path = tempfile.mkstemp(prefix="melostream-cookies-", suffix=".txt")
    try:
        with os.fdopen(file_descriptor, "wb") as cookie_file:
            cookie_file.write(cookies)
        yield cookie_path
    finally:
        try:
            os.remove(cookie_path)
        except FileNotFoundError:
            pass
