from __future__ import annotations

import secrets
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from flask_login import UserMixin
from sqlalchemy import CheckConstraint, Index, UniqueConstraint
from werkzeug.security import check_password_hash, generate_password_hash

from .extensions import db


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class TimestampMixin:
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class User(UserMixin, TimestampMixin, db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    phone = db.Column(db.String(20), nullable=False, unique=True, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), nullable=False, default="patient", index=True)
    language = db.Column(db.String(5), nullable=False, default="uz")
    address = db.Column(db.String(500), nullable=False, default="")
    latitude = db.Column(db.Float)
    longitude = db.Column(db.Float)
    is_active_account = db.Column(db.Boolean, nullable=False, default=True)
    must_change_password = db.Column(db.Boolean, nullable=False, default=False)
    last_login_at = db.Column(db.DateTime(timezone=True))

    orders = db.relationship("Order", back_populates="patient", foreign_keys="Order.patient_id")
    courier_orders = db.relationship("Order", back_populates="courier", foreign_keys="Order.courier_id")

    @property
    def is_active(self) -> bool:
        return bool(self.is_active_account)

    def set_password(self, password: str) -> None:
        self.password_hash = generate_password_hash(password, method="scrypt")

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "phone": self.phone,
            "role": self.role,
            "language": self.language,
            "address": self.address,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "must_change_password": self.must_change_password,
        }


class Branch(TimestampMixin, db.Model):
    __tablename__ = "branches"

    id = db.Column(db.Integer, primary_key=True)
    slug = db.Column(db.String(40), nullable=False, unique=True)
    name = db.Column(db.String(160), nullable=False)
    city = db.Column(db.String(80), nullable=False)
    address = db.Column(db.String(500), nullable=False)
    phone = db.Column(db.String(30), nullable=False)
    latitude = db.Column(db.Float, nullable=False)
    longitude = db.Column(db.Float, nullable=False)
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    stocks = db.relationship("Stock", back_populates="branch", cascade="all, delete-orphan")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "slug": self.slug,
            "name": self.name,
            "city": self.city,
            "address": self.address,
            "phone": self.phone,
            "latitude": self.latitude,
            "longitude": self.longitude,
        }


class Product(TimestampMixin, db.Model):
    __tablename__ = "products"

    id = db.Column(db.Integer, primary_key=True)
    sku = db.Column(db.String(60), nullable=False, unique=True)
    category = db.Column(db.String(50), nullable=False, index=True)
    name_uz = db.Column(db.String(180), nullable=False)
    name_ru = db.Column(db.String(180), nullable=False, default="")
    name_en = db.Column(db.String(180), nullable=False, default="")
    price = db.Column(db.Numeric(14, 2), nullable=False)
    cost_price = db.Column(db.Numeric(14, 2), nullable=False)
    old_price = db.Column(db.Numeric(14, 2))
    emoji = db.Column(db.String(20), nullable=False, default="💊")
    badge = db.Column(db.String(40), nullable=False, default="")
    prescription_required = db.Column(db.Boolean, nullable=False, default=False)
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    stocks = db.relationship("Stock", back_populates="product", cascade="all, delete-orphan")

    def to_dict(self, include_stock: bool = True) -> dict[str, Any]:
        data = {
            "id": self.id,
            "sku": self.sku,
            "category": self.category,
            "uz": self.name_uz,
            "ru": self.name_ru,
            "en": self.name_en,
            "price": int(self.price or 0),
            "cost_price": int(self.cost_price or 0),
            "old": int(self.old_price or 0),
            "emoji": self.emoji,
            "badge": self.badge,
            "prescription_required": self.prescription_required,
        }
        if include_stock:
            data["stock"] = {stock.branch.slug: stock.quantity for stock in self.stocks}
            data["total_stock"] = sum(stock.quantity for stock in self.stocks)
        return data


class Stock(TimestampMixin, db.Model):
    __tablename__ = "stocks"
    __table_args__ = (
        UniqueConstraint("branch_id", "product_id", name="uq_stock_branch_product"),
        CheckConstraint("quantity >= 0", name="ck_stock_nonnegative"),
    )

    id = db.Column(db.Integer, primary_key=True)
    branch_id = db.Column(db.Integer, db.ForeignKey("branches.id", ondelete="CASCADE"), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    quantity = db.Column(db.Integer, nullable=False, default=0)
    minimum_quantity = db.Column(db.Integer, nullable=False, default=5)

    branch = db.relationship("Branch", back_populates="stocks")
    product = db.relationship("Product", back_populates="stocks")


class Order(TimestampMixin, db.Model):
    __tablename__ = "orders"

    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(30), nullable=False, unique=True, index=True)
    tracking_token = db.Column(db.String(80), nullable=False, unique=True, default=lambda: secrets.token_urlsafe(32))
    patient_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    branch_id = db.Column(db.Integer, db.ForeignKey("branches.id"), nullable=False, index=True)
    courier_id = db.Column(db.Integer, db.ForeignKey("users.id"), index=True)
    method = db.Column(db.String(20), nullable=False, default="delivery")
    payment_method = db.Column(db.String(40), nullable=False, default="Naqd")
    payment_status = db.Column(db.String(20), nullable=False, default="pending")
    status = db.Column(db.String(40), nullable=False, default="Yangi", index=True)
    address = db.Column(db.String(500), nullable=False)
    latitude = db.Column(db.Float)
    longitude = db.Column(db.Float)
    total = db.Column(db.Numeric(14, 2), nullable=False, default=0)
    cost_total = db.Column(db.Numeric(14, 2), nullable=False, default=0)
    notes = db.Column(db.String(1000), nullable=False, default="")
    stock_reserved = db.Column(db.Boolean, nullable=False, default=False)
    delivered_at = db.Column(db.DateTime(timezone=True))
    cancelled_at = db.Column(db.DateTime(timezone=True))

    patient = db.relationship("User", foreign_keys=[patient_id], back_populates="orders")
    branch = db.relationship("Branch")
    courier = db.relationship("User", foreign_keys=[courier_id], back_populates="courier_orders")
    items = db.relationship("OrderItem", back_populates="order", cascade="all, delete-orphan")
    locations = db.relationship("CourierLocation", back_populates="order", cascade="all, delete-orphan")

    @property
    def profit(self) -> Decimal:
        return Decimal(self.total or 0) - Decimal(self.cost_total or 0)

    def to_dict(self, include_private: bool = True) -> dict[str, Any]:
        data = {
            "id": self.id,
            "code": self.code,
            "created": self.created_at.isoformat(),
            "date": self.created_at.astimezone().strftime("%d.%m.%Y %H:%M"),
            "branch": self.branch.city if self.branch else "",
            "branch_name": self.branch.name if self.branch else "",
            "payment": self.payment_method,
            "payment_status": self.payment_status,
            "method": self.method,
            "status": self.status,
            "total": int(self.total or 0),
            "cost": int(self.cost_total or 0),
            "profit": int(self.profit),
            "items": [item.to_dict() for item in self.items],
            "courier": self.courier.name if self.courier else None,
            "courier_id": self.courier_id,
            "tracking_token": self.tracking_token,
        }
        if include_private:
            data.update(
                {
                    "customer": self.patient.name if self.patient else "",
                    "phone": self.patient.phone if self.patient else "",
                    "address": self.address,
                    "lat": self.latitude,
                    "lon": self.longitude,
                    "notes": self.notes,
                    "courier_phone": self.courier.phone if self.courier else None,
                }
            )
        return data


class OrderItem(db.Model):
    __tablename__ = "order_items"

    id = db.Column(db.Integer, primary_key=True)
    order_id = db.Column(db.Integer, db.ForeignKey("orders.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), nullable=False)
    product_name = db.Column(db.String(180), nullable=False)
    quantity = db.Column(db.Integer, nullable=False)
    unit_price = db.Column(db.Numeric(14, 2), nullable=False)
    unit_cost = db.Column(db.Numeric(14, 2), nullable=False)

    order = db.relationship("Order", back_populates="items")
    product = db.relationship("Product")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.product_id,
            "name": self.product_name,
            "qty": self.quantity,
            "price": int(self.unit_price or 0),
        }


class CourierLocation(TimestampMixin, db.Model):
    __tablename__ = "courier_locations"
    __table_args__ = (Index("ix_courier_location_order_created", "order_id", "created_at"),)

    id = db.Column(db.Integer, primary_key=True)
    order_id = db.Column(db.Integer, db.ForeignKey("orders.id", ondelete="CASCADE"), nullable=False)
    courier_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    latitude = db.Column(db.Float, nullable=False)
    longitude = db.Column(db.Float, nullable=False)
    accuracy = db.Column(db.Float)
    heading = db.Column(db.Float)
    speed = db.Column(db.Float)

    order = db.relationship("Order", back_populates="locations")
    courier = db.relationship("User")

    def to_dict(self) -> dict[str, Any]:
        return {
            "lat": self.latitude,
            "lon": self.longitude,
            "accuracy": self.accuracy,
            "heading": self.heading,
            "speed": self.speed,
            "updated_at": self.created_at.isoformat(),
        }


class HealthPassport(TimestampMixin, db.Model):
    __tablename__ = "health_passports"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False)
    encrypted_payload = db.Column(db.Text, nullable=False, default="")
    consent = db.Column(db.Boolean, nullable=False, default=False)

    user = db.relationship("User")


class PatientVault(TimestampMixin, db.Model):
    __tablename__ = "patient_vaults"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False)
    encrypted_payload = db.Column(db.Text, nullable=False, default="")

    user = db.relationship("User")


class Prescription(TimestampMixin, db.Model):
    __tablename__ = "prescriptions"

    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(40), nullable=False, unique=True, index=True)
    patient_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    branch_id = db.Column(db.Integer, db.ForeignKey("branches.id"), nullable=False)
    original_filename = db.Column(db.String(255), nullable=False)
    stored_filename = db.Column(db.String(255), nullable=False, unique=True)
    mime_type = db.Column(db.String(120), nullable=False)
    status = db.Column(db.String(30), nullable=False, default="Yangi")
    pharmacist_id = db.Column(db.Integer, db.ForeignKey("users.id"))
    pharmacist_note = db.Column(db.String(1000), nullable=False, default="")
    consent = db.Column(db.Boolean, nullable=False, default=False)

    patient = db.relationship("User", foreign_keys=[patient_id])
    branch = db.relationship("Branch")
    pharmacist = db.relationship("User", foreign_keys=[pharmacist_id])

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "code": self.code,
            "patient": self.patient.name,
            "phone": self.patient.phone,
            "branch": self.branch.name,
            "filename": self.original_filename,
            "status": self.status,
            "pharmacist": self.pharmacist.name if self.pharmacist else None,
            "note": self.pharmacist_note,
            "created_at": self.created_at.isoformat(),
        }


class OtpCode(TimestampMixin, db.Model):
    __tablename__ = "otp_codes"

    id = db.Column(db.Integer, primary_key=True)
    phone = db.Column(db.String(20), nullable=False, index=True)
    purpose = db.Column(db.String(30), nullable=False, default="register")
    code_hash = db.Column(db.String(255), nullable=False)
    expires_at = db.Column(db.DateTime(timezone=True), nullable=False)
    attempts = db.Column(db.Integer, nullable=False, default=0)
    used_at = db.Column(db.DateTime(timezone=True))


class AuditLog(TimestampMixin, db.Model):
    __tablename__ = "audit_logs"
    __table_args__ = (Index("ix_audit_created_action", "created_at", "action"),)

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"))
    action = db.Column(db.String(80), nullable=False)
    entity_type = db.Column(db.String(80), nullable=False, default="")
    entity_id = db.Column(db.String(80), nullable=False, default="")
    detail = db.Column(db.Text, nullable=False, default="")
    ip_address = db.Column(db.String(64), nullable=False, default="")

    user = db.relationship("User")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "user": self.user.name if self.user else "Tizim",
            "role": self.user.role if self.user else "system",
            "action": self.action,
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
            "detail": self.detail,
            "created_at": self.created_at.isoformat(),
        }
