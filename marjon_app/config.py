from __future__ import annotations

import os
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def _bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Config:
    APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-only-change-this-secret")

    database_url = os.getenv("DATABASE_URL", f"sqlite:///{BASE_DIR / 'instance' / 'marjon.db'}")
    if database_url.startswith("postgres://"):
        database_url = database_url.replace("postgres://", "postgresql+psycopg://", 1)
    elif database_url.startswith("postgresql://") and "+psycopg" not in database_url:
        database_url = database_url.replace("postgresql://", "postgresql+psycopg://", 1)

    SQLALCHEMY_DATABASE_URI = database_url
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True}

    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = _bool("SESSION_COOKIE_SECURE", APP_ENV == "production")
    PERMANENT_SESSION_LIFETIME = timedelta(hours=int(os.getenv("SESSION_HOURS", "12")))

    MAX_CONTENT_LENGTH = int(os.getenv("MAX_UPLOAD_MB", "8")) * 1024 * 1024
    UPLOAD_FOLDER = str(BASE_DIR / "instance" / "uploads")
    ALLOWED_UPLOAD_EXTENSIONS = {"png", "jpg", "jpeg", "pdf"}

    DATA_ENCRYPTION_KEY = os.getenv("DATA_ENCRYPTION_KEY", "")
    REQUIRE_SMS_OTP = _bool("REQUIRE_SMS_OTP", False)
    SMS_WEBHOOK_URL = os.getenv("SMS_WEBHOOK_URL", "")
    SMS_WEBHOOK_TOKEN = os.getenv("SMS_WEBHOOK_TOKEN", "")

    ADMIN_NAME = os.getenv("ADMIN_NAME", "Marjon Rahbar")
    ADMIN_PHONE = os.getenv("ADMIN_PHONE", "+998900000000")
    ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")

    PHARMACIST_PHONE = os.getenv("PHARMACIST_PHONE", "+998900000001")
    PHARMACIST_PASSWORD = os.getenv("PHARMACIST_PASSWORD", "")
    COURIER_PHONE = os.getenv("COURIER_PHONE", "+998900000002")
    COURIER_PASSWORD = os.getenv("COURIER_PASSWORD", "")
    ACCOUNTANT_PHONE = os.getenv("ACCOUNTANT_PHONE", "+998900000003")
    ACCOUNTANT_PASSWORD = os.getenv("ACCOUNTANT_PASSWORD", "")

    AI_WEBHOOK_URL = os.getenv("AI_WEBHOOK_URL", "")
    AI_WEBHOOK_TOKEN = os.getenv("AI_WEBHOOK_TOKEN", "")

    PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "")
    ALLOW_PRODUCTION_SQLITE = _bool("ALLOW_PRODUCTION_SQLITE", False)
