from __future__ import annotations

import math
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from flask import current_app
from werkzeug.utils import secure_filename

from .extensions import db
from .models import Branch, Order, Product, Stock, User


STATUS_TRANSITIONS: dict[str, set[str]] = {
    "Yangi": {"Tasdiqlandi", "Bekor qilindi"},
    "Tasdiqlandi": {"Tayyorlanmoqda", "Bekor qilindi"},
    "Tayyorlanmoqda": {"Kuryerga berildi", "Tayyor", "Bekor qilindi"},
    "Tayyor": {"Kuryerga berildi", "Yetkazildi", "Bekor qilindi"},
    "Kuryerga berildi": {"Yetkazilmoqda", "Bekor qilindi"},
    "Yetkazilmoqda": {"Yetkazildi", "Yetkazilmadi"},
    "Yetkazilmadi": {"Kuryerga berildi", "Bekor qilindi"},
    "Yetkazildi": set(),
    "Bekor qilindi": set(),
}


def can_transition(order: Order, new_status: str, role: str) -> bool:
    if role in {"manager", "admin"}:
        return new_status in STATUS_TRANSITIONS.get(order.status, set()) or new_status == order.status
    if role == "pharmacist":
        allowed = {"Tasdiqlandi", "Tayyorlanmoqda", "Tayyor", "Kuryerga berildi", "Bekor qilindi"}
        return new_status in allowed and new_status in STATUS_TRANSITIONS.get(order.status, set())
    if role == "courier":
        allowed = {"Yetkazilmoqda", "Yetkazildi", "Yetkazilmadi"}
        return new_status in allowed and new_status in STATUS_TRANSITIONS.get(order.status, set())
    return False


def reserve_stock(order: Order) -> tuple[bool, str]:
    if order.stock_reserved:
        return True, ""
    for item in order.items:
        stock = Stock.query.filter_by(branch_id=order.branch_id, product_id=item.product_id).with_for_update().first()
        if not stock or stock.quantity < item.quantity:
            return False, f"{item.product_name} uchun qoldiq yetarli emas."
    for item in order.items:
        stock = Stock.query.filter_by(branch_id=order.branch_id, product_id=item.product_id).with_for_update().first()
        stock.quantity -= item.quantity
    order.stock_reserved = True
    return True, ""


def restore_stock(order: Order) -> None:
    if not order.stock_reserved:
        return
    for item in order.items:
        stock = Stock.query.filter_by(branch_id=order.branch_id, product_id=item.product_id).with_for_update().first()
        if stock:
            stock.quantity += item.quantity
    order.stock_reserved = False


def order_code() -> str:
    stamp = datetime.now(timezone.utc).strftime("%y%m%d")
    return f"MJ-{stamp}-{secrets.randbelow(1_000_000):06d}"


def prescription_code() -> str:
    return f"RX-{datetime.now(timezone.utc).strftime('%y%m%d')}-{secrets.randbelow(1_000_000):06d}"


def save_private_upload(file_storage: Any) -> tuple[str, str, str]:
    original = secure_filename(file_storage.filename or "file")
    ext = original.rsplit(".", 1)[-1].lower() if "." in original else ""
    if ext not in current_app.config["ALLOWED_UPLOAD_EXTENSIONS"]:
        raise ValueError("Faqat JPG, PNG yoki PDF fayl yuborish mumkin.")

    header = file_storage.stream.read(16)
    file_storage.stream.seek(0)
    signatures = {
        "pdf": (b"%PDF-", "application/pdf"),
        "png": (b"\x89PNG\r\n\x1a\n", "image/png"),
        "jpg": (b"\xff\xd8\xff", "image/jpeg"),
        "jpeg": (b"\xff\xd8\xff", "image/jpeg"),
    }
    signature, mime_type = signatures[ext]
    if not header.startswith(signature):
        raise ValueError("Fayl kengaytmasi uning haqiqiy formatiga mos emas.")

    stored = f"{secrets.token_urlsafe(24)}.{ext}"
    folder = Path(current_app.config["UPLOAD_FOLDER"])
    folder.mkdir(parents=True, exist_ok=True)
    file_storage.save(folder / stored)
    return original, stored, mime_type


def send_sms(phone: str, message: str) -> bool:
    url = current_app.config.get("SMS_WEBHOOK_URL", "")
    if not url:
        return False
    headers = {"Content-Type": "application/json"}
    token = current_app.config.get("SMS_WEBHOOK_TOKEN", "")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        response = requests.post(url, json={"phone": phone, "message": message}, headers=headers, timeout=12)
        return 200 <= response.status_code < 300
    except requests.RequestException:
        return False


def ask_ai(question: str, language: str = "uz") -> dict[str, Any]:
    text = (question or "").strip()
    lower = text.lower()
    urgent_words = [
        "nafas", "hush", "qon ket", "ko‘krak", "tutqanoq", "bo‘g‘il", "yuz shish",
        "не дыш", "без созн", "кровотеч", "chest pain", "unconscious", "severe bleeding",
    ]
    if any(word in lower for word in urgent_words):
        return {
            "type": "urgent",
            "answer": "Shoshilinch holat bo‘lishi mumkin. AI javobini kutmang: xavfsiz joyda bo‘ling va 103 ga qo‘ng‘iroq qiling.",
        }

    webhook = current_app.config.get("AI_WEBHOOK_URL", "")
    if webhook:
        headers = {"Content-Type": "application/json"}
        token = current_app.config.get("AI_WEBHOOK_TOKEN", "")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            response = requests.post(
                webhook,
                json={"question": text, "language": language, "safety_mode": "pharmacy_no_diagnosis"},
                headers=headers,
                timeout=20,
            )
            response.raise_for_status()
            data = response.json()
            answer = str(data.get("answer", "")).strip()
            if answer:
                return {"type": "external", "answer": answer}
        except (requests.RequestException, ValueError):
            pass

    if any(word in lower for word in ["retsept", "рецепт", "prescription"]):
        answer = "Retsept bo‘yicha yakuniy qarorni farmatsevt beradi. Retsept rasmini yuboring yoki farmatsevt kabinetiga murojaat qiling."
    elif any(word in lower for word in ["filial", "manzil", "branch", "адрес"]):
        answer = "Filiallar bo‘limidan eng yaqin dorixonani lokatsiya orqali topishingiz mumkin."
    elif any(word in lower for word in ["qoldiq", "mavjud", "stock", "налич"]):
        answer = "Dori nomini katalog qidiruviga yozing. Qoldiq serverdagi filial ma’lumotlaridan ko‘rsatiladi."
    else:
        answer = "Men mahsulot qidirish, filial, buyurtma va retsept jarayoni bo‘yicha yordam beraman. Tashxis, doza yoki dori tayinlash uchun shifokor yoki farmatsevtga murojaat qiling."
    return {"type": "local", "answer": answer}


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def seed_catalog() -> None:
    # Faqat buyurtmachi bergan 8 ta filial faol ko‘rinadi.
    # Eski filiallar o‘chirilmaydi: mavjud buyurtmalar buzilmasligi uchun nofaol qilinadi.
    desired_branches = [
        ("chilonzor-parvus", "Chilonzor Parvus", "Toshkent", "Toshkent shahri, Chilonzor Parvus filiali", "", 0.0, 0.0),
        ("mirabod", "Mirabod", "Toshkent", "Toshkent shahri, Mirabod filiali", "", 0.0, 0.0),
        ("qoasuv-1", "Qoasuv 1", "Toshkent", "Toshkent shahri, Qoasuv 1 filiali", "", 0.0, 0.0),
        ("ttz-yuzrabod", "TTZ Yuzrabod ko‘chasi", "Toshkent", "Toshkent shahri, TTZ Yuzrabod ko‘chasi filiali", "", 0.0, 0.0),
        ("ttz-buyuk-ipak-yoli", "TTZ Buyuk Ipak yo‘li ko‘chasi", "Toshkent", "Toshkent shahri, TTZ Buyuk Ipak yo‘li ko‘chasi filiali", "", 0.0, 0.0),
        ("mirzo-ulugbek-pushkin", "Mirzo Ulug‘bek Pushkin", "Toshkent", "Toshkent shahri, Mirzo Ulug‘bek Pushkin filiali", "", 0.0, 0.0),
        ("sebzor", "Sebzor", "Toshkent", "Toshkent shahri, Sebzor filiali", "", 0.0, 0.0),
        ("s-1", "S-1", "Toshkent", "Toshkent shahri, S-1 filiali", "", 0.0, 0.0),
    ]
    desired_slugs = {item[0] for item in desired_branches}

    for existing in Branch.query.all():
        existing.is_active = existing.slug in desired_slugs

    for slug, name, city, address, phone, lat, lon in desired_branches:
        branch = Branch.query.filter_by(slug=slug).first()
        if branch is None:
            branch = Branch(slug=slug)
            db.session.add(branch)
        branch.name = name
        branch.city = city
        branch.address = address
        branch.phone = phone
        branch.latitude = lat
        branch.longitude = lon
        branch.is_active = True
    db.session.flush()

    if Product.query.count() == 0:
        products = [
            ("MFT-001", "cold", "Teraflyu kukun №10", "Терафлю порошок №10", "Theraflu powder No.10", 90000, 69000, 94500, "🍋", "Aksiya", False),
            ("MFT-002", "pain", "Tenoten tabletka №40", "Тенотен таблетки №40", "Tenoten tablets No.40", 41000, 30000, 43500, "💊", "Dolzarb", False),
            ("MFT-003", "children", "Pikovit sirop 150 ml", "Пиковит сироп 150 мл", "Pikovit syrup 150 ml", 65000, 48000, 0, "🧸", "Top", False),
            ("MFT-004", "vitamin", "B-Complex vitaminlari", "Витамины B-Complex", "B-Complex vitamins", 78000, 56000, 83000, "🍊", "Aksiya", False),
            ("MFT-005", "medical", "Elektron tonometr", "Электронный тонометр", "Digital blood pressure monitor", 340000, 275000, 369000, "🩺", "Top", False),
            ("MFT-006", "children", "Bolalar tagligi 24 dona", "Подгузники 24 шт.", "Baby diapers 24 pcs", 118000, 93000, 125000, "👶", "Aksiya", False),
            ("MFT-007", "care", "Antiseptik gel 100 ml", "Антисептик-гель 100 мл", "Antiseptic gel 100 ml", 22000, 14500, 0, "🧴", "Yangi", False),
            ("MFT-008", "cold", "Paratsetamol 500 mg №10", "Парацетамол 500 мг №10", "Paracetamol 500 mg No.10", 8000, 5200, 0, "🌡️", "Dolzarb", False),
        ]
        for sku, category, uz, ru, en, price, cost, old, emoji, badge, rx in products:
            db.session.add(Product(sku=sku, category=category, name_uz=uz, name_ru=ru, name_en=en, price=price, cost_price=cost, old_price=old or None, emoji=emoji, badge=badge, prescription_required=rx))
        db.session.flush()

    # Har bir faol filial uchun ombor yozuvi bo‘lsin.
    active_branches = Branch.query.filter_by(is_active=True).order_by(Branch.id).all()
    for product in Product.query.order_by(Product.id).all():
        for branch in active_branches:
            stock = Stock.query.filter_by(branch_id=branch.id, product_id=product.id).first()
            if stock is None:
                db.session.add(Stock(branch_id=branch.id, product_id=product.id, quantity=10, minimum_quantity=5))
    db.session.commit()


def seed_users() -> list[str]:
    created: list[str] = []
    env = current_app.config["APP_ENV"]
    users = [
        ("manager", current_app.config["ADMIN_NAME"], current_app.config["ADMIN_PHONE"], current_app.config["ADMIN_PASSWORD"]),
        ("pharmacist", "Zam Zam Pharm Trade Farmatsevt", current_app.config["PHARMACIST_PHONE"], current_app.config["PHARMACIST_PASSWORD"]),
        ("courier", "Zam Zam Pharm Trade Kuryer", current_app.config["COURIER_PHONE"], current_app.config["COURIER_PASSWORD"]),
        ("accountant", "Zam Zam Pharm Trade Buxgalter", current_app.config["ACCOUNTANT_PHONE"], current_app.config["ACCOUNTANT_PASSWORD"]),
    ]
    demo_passwords = {"manager": "Marjon2026!", "pharmacist": "Farm2026!", "courier": "Kuryer2026!", "accountant": "Hisob2026!"}
    for role, name, phone, password in users:
        if User.query.filter_by(phone=phone).first():
            continue
        chosen = password or (demo_passwords[role] if env != "production" else "")
        if not chosen:
            continue
        user = User(name=name, phone=phone, role=role, language="uz", must_change_password=(env == "production" or not password))
        user.set_password(chosen)
        db.session.add(user)
        created.append(f"{role}: {phone}")
    db.session.commit()
    return created
