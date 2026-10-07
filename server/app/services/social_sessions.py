import os
import tempfile
import uuid
from collections.abc import Iterator
from contextlib import contextmanager

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import SocialPlatform, UserSocialAccount


class SocialAccountMissingError(Exception):
    pass


def _fernet() -> Fernet:
    if not settings.SOCIAL_COOKIE_ENCRYPTION_KEY:
        raise RuntimeError(
            "SOCIAL_COOKIE_ENCRYPTION_KEY must be configured before storing or using social cookies."
        )
    return Fernet(settings.SOCIAL_COOKIE_ENCRYPTION_KEY.get_secret_value().encode("ascii"))


def encrypt_cookies(cookies: str) -> str:
    return _fernet().encrypt(cookies.encode("utf-8")).decode("ascii")


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

    try:
        cookies = _fernet().decrypt(account.encrypted_cookies.encode("ascii"))
    except InvalidToken as exc:
        raise RuntimeError(
            "Saved social cookies could not be decrypted; verify SOCIAL_COOKIE_ENCRYPTION_KEY."
        ) from exc

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
