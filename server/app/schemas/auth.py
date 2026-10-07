import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator

SocialPlatformName = Literal["youtube", "tiktok", "telegram"]


class SignUpRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=10, max_length=72)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", normalized):
            raise ValueError("A valid email address is required.")
        return normalized

    @field_validator("password")
    @classmethod
    def validate_bcrypt_length(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Passwords must be no longer than 72 UTF-8 bytes.")
        return value


class UserResponse(BaseModel):
    id: str
    email: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


class SocialCookieRequest(BaseModel):
    cookies: str = Field(min_length=1, max_length=1_000_000)


class SocialAccountResponse(BaseModel):
    platform: SocialPlatformName
    configured: bool = True
    updated_at: str
