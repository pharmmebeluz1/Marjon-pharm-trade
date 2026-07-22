from __future__ import annotations

import time
from collections import defaultdict, deque
from datetime import datetime, timezone

from flask import Blueprint, current_app, jsonify, request, session
from flask_login import current_user, login_required, login_user, logout_user

from .extensions import db
from .models import User
from .security import (
    audit,
    create_otp,
    get_csrf_token,
    normalize_phone,
    valid_phone,
    validate_password,
    verify_otp,
)
from .services import send_sms

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

_LOGIN_ATTEMPTS: dict[str, deque[float]] = defaultdict(deque)


def _rate_limited(key: str, limit: int = 8, window: int = 300) -> bool:
    now = time.time()
    queue = _LOGIN_ATTEMPTS[key]
    while queue and queue[0] < now - window:
        queue.popleft()
    if len(queue) >= limit:
        return True
    queue.append(now)
    return False


@bp.get("/csrf")
def csrf():
    return jsonify({"ok": True, "csrf_token": get_csrf_token()})


@bp.get("/me")
def me():
    return jsonify(
        {
            "ok": True,
            "authenticated": current_user.is_authenticated,
            "user": current_user.to_dict() if current_user.is_authenticated else None,
            "csrf_token": get_csrf_token(),
            "require_sms_otp": bool(current_app.config["REQUIRE_SMS_OTP"]),
            "environment": current_app.config["APP_ENV"],
        }
    )


@bp.post("/request-otp")
def request_otp():
    payload = request.get_json(silent=True) or {}
    phone = normalize_phone(payload.get("phone", ""))
    purpose = str(payload.get("purpose", "register"))[:30]
    if not valid_phone(phone):
        return jsonify({"ok": False, "error": "Telefon raqamini +998XXXXXXXXX ko‘rinishida yozing."}), 400
    key = f"otp:{request.remote_addr}:{phone}"
    if _rate_limited(key, limit=4, window=600):
        return jsonify({"ok": False, "error": "Juda ko‘p urinish. 10 daqiqadan keyin qayta urinib ko‘ring."}), 429
    code = create_otp(phone, purpose)
    sent = send_sms(phone, f"Pharm360° tasdiqlash kodi: {code}. Kod 5 daqiqa amal qiladi.")
    response = {"ok": True, "sent": sent, "message": "Tasdiqlash kodi yuborildi." if sent else "SMS provayder ulanmagan."}
    if current_app.config["APP_ENV"] != "production":
        response["demo_code"] = code
        response["message"] = "Demo rejim: tasdiqlash kodi ekranda ko‘rsatiladi."
    elif not sent:
        return jsonify({"ok": False, "error": "SMS provayder sozlanmagan. Administratorga murojaat qiling."}), 503
    return jsonify(response)


@bp.post("/register")
def register():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()[:120]
    phone = normalize_phone(payload.get("phone", ""))
    password = str(payload.get("password", ""))
    language = str(payload.get("language", "uz"))[:5]
    address = str(payload.get("address", "")).strip()[:500]
    consent = bool(payload.get("consent"))
    otp = str(payload.get("otp", "")).strip()

    if not name or not valid_phone(phone) or not consent:
        return jsonify({"ok": False, "error": "Ism, to‘g‘ri telefon va rozilik majburiy."}), 400
    ok, message = validate_password(password)
    if not ok:
        return jsonify({"ok": False, "error": message}), 400
    if User.query.filter_by(phone=phone).first():
        return jsonify({"ok": False, "error": "Bu telefon raqami avval ro‘yxatdan o‘tgan."}), 409
    if current_app.config["REQUIRE_SMS_OTP"] and not verify_otp(phone, "register", otp):
        return jsonify({"ok": False, "error": "Tasdiqlash kodi noto‘g‘ri yoki muddati tugagan."}), 400

    user = User(
        name=name,
        phone=phone,
        role="patient",
        language=language if language in {"uz", "ru", "en"} else "uz",
        address=address,
        latitude=payload.get("latitude"),
        longitude=payload.get("longitude"),
    )
    user.set_password(password)
    db.session.add(user)
    db.session.flush()
    audit("patient_registered", "user", user.id, f"phone={phone}")
    db.session.commit()
    login_user(user, remember=False, fresh=True)
    session.permanent = True
    session["csrf_token"] = get_csrf_token()
    return jsonify({"ok": True, "user": user.to_dict(), "csrf_token": get_csrf_token()}), 201


@bp.post("/login")
def login():
    payload = request.get_json(silent=True) or {}
    phone = normalize_phone(payload.get("phone", ""))
    password = str(payload.get("password", ""))
    key = f"login:{request.remote_addr}:{phone}"
    if _rate_limited(key):
        return jsonify({"ok": False, "error": "Juda ko‘p xato urinish. 5 daqiqadan keyin qayta urinib ko‘ring."}), 429
    user = User.query.filter_by(phone=phone).first()
    if not user or not user.check_password(password) or not user.is_active_account:
        return jsonify({"ok": False, "error": "Telefon yoki parol noto‘g‘ri."}), 401
    login_user(user, remember=bool(payload.get("remember")), fresh=True)
    session.permanent = True
    user.last_login_at = datetime.now(timezone.utc)
    audit("login", "user", user.id)
    db.session.commit()
    return jsonify({"ok": True, "user": user.to_dict(), "csrf_token": get_csrf_token()})


@bp.post("/logout")
@login_required
def logout():
    audit("logout", "user", current_user.id)
    db.session.commit()
    logout_user()
    session.clear()
    return jsonify({"ok": True})


@bp.post("/change-password")
@login_required
def change_password():
    payload = request.get_json(silent=True) or {}
    current_password = str(payload.get("current_password", ""))
    new_password = str(payload.get("new_password", ""))
    if not current_user.check_password(current_password):
        return jsonify({"ok": False, "error": "Joriy parol noto‘g‘ri."}), 400
    ok, message = validate_password(new_password)
    if not ok:
        return jsonify({"ok": False, "error": message}), 400
    if current_password == new_password:
        return jsonify({"ok": False, "error": "Yangi parol eski paroldan farq qilsin."}), 400
    current_user.set_password(new_password)
    current_user.must_change_password = False
    audit("password_changed", "user", current_user.id)
    db.session.commit()
    return jsonify({"ok": True, "user": current_user.to_dict()})


@bp.put("/profile")
@login_required
def update_profile():
    payload = request.get_json(silent=True) or {}
    current_user.name = str(payload.get("name", current_user.name)).strip()[:120] or current_user.name
    current_user.language = str(payload.get("language", current_user.language))[:5]
    current_user.address = str(payload.get("address", current_user.address)).strip()[:500]
    if payload.get("latitude") is not None:
        current_user.latitude = float(payload["latitude"])
    if payload.get("longitude") is not None:
        current_user.longitude = float(payload["longitude"])
    audit("profile_updated", "user", current_user.id)
    db.session.commit()
    return jsonify({"ok": True, "user": current_user.to_dict()})
