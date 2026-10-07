from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from redis import Redis
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db import get_db
from app.models import SocialPlatform, User, UserSocialAccount
from app.schemas.auth import (
    SignUpRequest,
    SocialAccountResponse,
    SocialCookieRequest,
    TokenResponse,
    UserResponse,
)
from app.security import (
    create_access_token,
    create_refresh_token,
    decode_access_token,
    hash_password,
    revoke_refresh_token,
    rotate_refresh_token,
    verify_password,
)
from app.services.social_sessions import encrypt_cookies

router = APIRouter()
oauth2_scheme = OAuth2PasswordBearer(
    tokenUrl=f"{settings.API_V1_STR}/auth/token", auto_error=False
)


def get_redis() -> Redis:
    return Redis.from_url(settings.REDIS_URL)


def _set_auth_cookies(response: Response, access_token: str, refresh_token: str) -> None:
    common = {
        "secure": settings.AUTH_COOKIE_SECURE,
        "httponly": True,
        "samesite": settings.AUTH_COOKIE_SAMESITE,
        "path": settings.API_V1_STR,
    }
    response.set_cookie(
        "access_token",
        access_token,
        max_age=settings.ACCESS_TOKEN_MINUTES * 60,
        **common,
    )
    response.set_cookie(
        "refresh_token",
        refresh_token,
        max_age=settings.REFRESH_TOKEN_DAYS * 24 * 60 * 60,
        **common,
    )


def _issue_tokens(response: Response, user: User, redis_client: Redis) -> TokenResponse:
    try:
        access_token = create_access_token(user.id)
        refresh_token = create_refresh_token(user.id, redis_client)
    except RedisError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The session service is unavailable. Please try again.",
        ) from exc
    _set_auth_cookies(response, access_token, refresh_token)
    return TokenResponse(
        access_token=access_token,
        user=UserResponse(id=str(user.id), email=user.email),
    )


def get_optional_user(
    request: Request,
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User | None:
    token = token or request.cookies.get("access_token")
    if not token:
        return None
    user_id = decode_access_token(token)
    if user_id is None:
        return None
    user = db.get(User, user_id)
    if user is None:
        return None
    return user


def get_current_user(user: User | None = Depends(get_optional_user)) -> User:
    if user is None:
        raise HTTPException(status_code=401, detail="Please log in to download this video")
    return user


@router.post("/signup", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def sign_up(payload: SignUpRequest, db: Session = Depends(get_db)) -> UserResponse:
    user = User(email=payload.email, password_hash=hash_password(payload.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="An account with this email already exists.") from exc
    db.refresh(user)
    return UserResponse(id=str(user.id), email=user.email)


@router.post("/token", response_model=TokenResponse)
def login(
    response: Response,
    form: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
    redis_client: Redis = Depends(get_redis),
) -> TokenResponse:
    email = form.username.strip().lower()
    user = db.scalar(select(User).where(User.email == email))
    if user is None or not verify_password(form.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Incorrect email or password.")
    return _issue_tokens(response, user, redis_client)


@router.post("/refresh", response_model=TokenResponse)
def refresh_session(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    redis_client: Redis = Depends(get_redis),
) -> TokenResponse:
    refresh_token = request.cookies.get("refresh_token")
    if not refresh_token:
        raise HTTPException(status_code=401, detail="Your session has expired. Please log in.")
    try:
        user_id = rotate_refresh_token(refresh_token, redis_client)
    except RedisError as exc:
        raise HTTPException(status_code=503, detail="The session service is unavailable.") from exc
    if user_id is None:
        response.delete_cookie("access_token", path=settings.API_V1_STR)
        response.delete_cookie("refresh_token", path=settings.API_V1_STR)
        raise HTTPException(status_code=401, detail="Your session has expired. Please log in.")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Your session has expired. Please log in.")
    return _issue_tokens(response, user, redis_client)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, response: Response, redis_client: Redis = Depends(get_redis)) -> None:
    refresh_token = request.cookies.get("refresh_token")
    if refresh_token:
        try:
            revoke_refresh_token(refresh_token, redis_client)
        except RedisError as exc:
            raise HTTPException(status_code=503, detail="The session service is unavailable.") from exc
    response.delete_cookie("access_token", path=settings.API_V1_STR)
    response.delete_cookie("refresh_token", path=settings.API_V1_STR)


@router.get("/me", response_model=UserResponse)
def who_am_i(user: User = Depends(get_current_user)) -> UserResponse:
    return UserResponse(id=str(user.id), email=user.email)


@router.get("/social-accounts", response_model=list[SocialAccountResponse])
def list_social_accounts(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[SocialAccountResponse]:
    accounts = db.scalars(
        select(UserSocialAccount).where(UserSocialAccount.user_id == user.id)
    ).all()
    return [
        SocialAccountResponse(
            platform=account.platform, updated_at=account.updated_at.isoformat()
        )
        for account in accounts
    ]


@router.put("/social-accounts/{platform}", response_model=SocialAccountResponse)
def save_social_account(
    platform: SocialPlatform,
    payload: SocialCookieRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SocialAccountResponse:
    encrypted_cookies = encrypt_cookies(payload.cookies)
    account = db.scalar(
        select(UserSocialAccount).where(
            UserSocialAccount.user_id == user.id,
            UserSocialAccount.platform == platform,
        )
    )
    if account is None:
        account = UserSocialAccount(
            user_id=user.id, platform=platform, encrypted_cookies=encrypted_cookies
        )
        db.add(account)
    else:
        account.encrypted_cookies = encrypted_cookies
    db.commit()
    db.refresh(account)
    return SocialAccountResponse(
        platform=account.platform, updated_at=account.updated_at.isoformat()
    )


@router.delete("/social-accounts/{platform}", status_code=status.HTTP_204_NO_CONTENT)
def delete_social_account(
    platform: SocialPlatform,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    account = db.scalar(
        select(UserSocialAccount).where(
            UserSocialAccount.user_id == user.id,
            UserSocialAccount.platform == platform,
        )
    )
    if account is not None:
        db.delete(account)
        db.commit()
