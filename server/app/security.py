import uuid
from datetime import UTC, datetime, timedelta

import bcrypt
from jose import JWTError, jwt
from redis import Redis

from app.core.config import settings

ALGORITHM = "HS256"
REFRESH_TOKEN_PREFIX = "refresh:"


def _secret() -> str:
    if not settings.JWT_SECRET_KEY:
        raise RuntimeError("JWT_SECRET_KEY must be configured before using authentication.")
    return settings.JWT_SECRET_KEY.get_secret_value()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("ascii"))
    except (ValueError, UnicodeError):
        return False


def create_access_token(user_id: uuid.UUID) -> str:
    expires_at = datetime.now(UTC) + timedelta(minutes=settings.ACCESS_TOKEN_MINUTES)
    return jwt.encode(
        {"sub": str(user_id), "type": "access", "exp": expires_at},
        _secret(),
        algorithm=ALGORITHM,
    )


def create_refresh_token(user_id: uuid.UUID, redis_client: Redis) -> str:
    token_id = str(uuid.uuid4())
    expires_at = datetime.now(UTC) + timedelta(days=settings.REFRESH_TOKEN_DAYS)
    token = jwt.encode(
        {"sub": str(user_id), "type": "refresh", "jti": token_id, "exp": expires_at},
        _secret(),
        algorithm=ALGORITHM,
    )
    redis_client.setex(
        f"{REFRESH_TOKEN_PREFIX}{token_id}",
        settings.REFRESH_TOKEN_DAYS * 24 * 60 * 60,
        str(user_id),
    )
    return token


def decode_access_token(token: str) -> uuid.UUID | None:
    try:
        claims = jwt.decode(token, _secret(), algorithms=[ALGORITHM])
        if claims.get("type") != "access":
            return None
        return uuid.UUID(claims["sub"])
    except (JWTError, KeyError, ValueError):
        return None


def rotate_refresh_token(token: str, redis_client: Redis) -> uuid.UUID | None:
    try:
        claims = jwt.decode(token, _secret(), algorithms=[ALGORITHM])
        if claims.get("type") != "refresh":
            return None
        user_id = uuid.UUID(claims["sub"])
        token_id = claims["jti"]
    except (JWTError, KeyError, ValueError):
        return None

    stored_user_id = redis_client.getdel(f"{REFRESH_TOKEN_PREFIX}{token_id}")
    if stored_user_id is None or stored_user_id.decode("utf-8") != str(user_id):
        return None
    return user_id


def revoke_refresh_token(token: str, redis_client: Redis) -> None:
    try:
        claims = jwt.decode(token, _secret(), algorithms=[ALGORITHM])
    except JWTError:
        return
    token_id = claims.get("jti")
    if token_id:
        redis_client.delete(f"{REFRESH_TOKEN_PREFIX}{token_id}")
