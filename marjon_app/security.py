from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
from datetime import datetime, timedelta, timezone
from functools import wraps
from typing import Any, Callable, TypeVar, cast

from cryptography.fernet import Fernet, InvalidToken
from flask import abort, current_app, jsonify, request, session
from flask_login import current_user

from .extensions import db
from .models import AuditLog, OtpCode, utcnow

F = TypeVar("F", bound=Callable[..., Any])

PHONE_RE = re.compile(r"^\+998\d{9}$")


def normalize_phone(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if digits.startswith("998") and len(digits) == 12:
        return "+" + digits
    if len(digits) == 9:
        return "+998" + digits
    return "+" + digits if digits else ""


def valid_phone(value: str) -> bool:
    return bool(PHONE_RE.fullmatch(normalize_phone(value)))


def validate_password(password: str) -> tuple[bool, str]:
    if len(password or "") < 8:
        return False, "Parol kamida 8 ta belgidan iborat bo‘lsin."
    if not re.search(r"[A-Za-zА-Яа-я]", password):
        return False, "Parolda kamida bitta harf bo‘lsin."
    if not re.search(r"\d", password):
        return False, "Parolda kamida bitta raqam bo‘lsin."
    return True, ""


def get_csrf_token() -> str:
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def csrf_protect() -> None:
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    if request.endpoint in {"api.ai_ask"}:
        return
    if request.endpoint and request.endpoint.endswith("payment_webhook"):
        return
    expected = session.get("csrf_token")
    supplied = request.headers.get("X-CSRF-Token", "")
    if not expected or not supplied or not hmac.compare_digest(expected, supplied):
        abort(400, description="CSRF token noto‘g‘ri yoki muddati tugagan.")


def role_required(*roles: str) -> Callable[[F], F]:
    def decorator(func: F) -> F:
        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any):
            if not current_user.is_authenticated:
                return jsonify({"ok": False, "error": "Avval tizimga kiring.", "code": "AUTH_REQUIRED"}), 401
            if current_user.role not in roles:
                return jsonify({"ok": False, "error": "Bu bo‘lim uchun ruxsat yo‘q.", "code": "FORBIDDEN"}), 403
            if getattr(current_user, "must_change_password", False) and request.endpoint != "auth.change_password":
                return jsonify({"ok": False, "error": "Avval vaqtinchalik parolni almashtiring.", "code": "PASSWORD_CHANGE_REQUIRED"}), 403
            return func(*args, **kwargs)

        return cast(F, wrapper)

    return decorator


def audit(action: str, entity_type: str = "", entity_id: str | int = "", detail: str = "") -> None:
    user_id = current_user.id if getattr(current_user, "is_authenticated", False) else None
    forwarded = request.headers.get("X-Forwarded-For", "")
    ip = (forwarded.split(",")[0].strip() if forwarded else request.remote_addr) or ""
    db.session.add(
        AuditLog(
            user_id=user_id,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id or ""),
            detail=(detail or "")[:4000],
            ip_address=ip[:64],
        )
    )


def _fernet() -> Fernet:
    configured = current_app.config.get("DATA_ENCRYPTION_KEY", "").strip()
    if configured:
        try:
            key = configured.encode("ascii")
            Fernet(key)
            return Fernet(key)
        except (ValueError, TypeError):
            raise RuntimeError("DATA_ENCRYPTION_KEY haqiqiy Fernet kaliti bo‘lishi kerak.")
    # Development-friendly fallback. Production README requires a separate key.
    digest = hashlib.sha256(current_app.config["SECRET_KEY"].encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_json(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return _fernet().encrypt(raw).decode("ascii")


def decrypt_json(token: str) -> dict[str, Any]:
    if not token:
        return {}
    try:
        raw = _fernet().decrypt(token.encode("ascii"))
        value = json.loads(raw.decode("utf-8"))
        return value if isinstance(value, dict) else {}
    except (InvalidToken, ValueError, json.JSONDecodeError):
        return {}


def create_otp(phone: str, purpose: str) -> str:
    phone = normalize_phone(phone)
    code = f"{secrets.randbelow(1_000_000):06d}"
    code_hash = hashlib.sha256((code + current_app.config["SECRET_KEY"]).encode("utf-8")).hexdigest()
    OtpCode.query.filter_by(phone=phone, purpose=purpose, used_at=None).delete()
    db.session.add(
        OtpCode(
            phone=phone,
            purpose=purpose,
            code_hash=code_hash,
            expires_at=utcnow() + timedelta(minutes=5),
        )
    )
    db.session.commit()
    return code


def verify_otp(phone: str, purpose: str, code: str) -> bool:
    phone = normalize_phone(phone)
    record = (
        OtpCode.query.filter_by(phone=phone, purpose=purpose, used_at=None)
        .order_by(OtpCode.created_at.desc())
        .first()
    )
    if not record or record.attempts >= 5:
        return False
    expires_at = record.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < datetime.now(timezone.utc):
        return False
    record.attempts += 1
    supplied_hash = hashlib.sha256(((code or "") + current_app.config["SECRET_KEY"]).encode("utf-8")).hexdigest()
    ok = hmac.compare_digest(record.code_hash, supplied_hash)
    if ok:
        record.used_at = utcnow()
    db.session.commit()
    return ok
