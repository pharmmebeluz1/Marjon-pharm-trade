from __future__ import annotations

import logging
from pathlib import Path

import click
from cryptography.fernet import Fernet
from flask import Flask, jsonify, request, send_file, send_from_directory
from flask_login import current_user
from werkzeug.middleware.proxy_fix import ProxyFix

from .config import Config
from .extensions import db, login_manager
from .models import User
from .security import csrf_protect, normalize_phone, validate_password
from .services import seed_catalog, seed_users


def create_app(test_config: dict | None = None) -> Flask:
    app = Flask(__name__, instance_relative_config=True, template_folder="../templates", static_folder="../static")
    app.config.from_object(Config)
    if test_config:
        app.config.update(test_config)

    Path(app.instance_path).mkdir(parents=True, exist_ok=True)
    Path(app.config["UPLOAD_FOLDER"]).mkdir(parents=True, exist_ok=True)

    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)  # type: ignore[assignment]
    db.init_app(app)
    login_manager.init_app(app)

    from .auth import bp as auth_bp
    from .api import bp as api_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(api_bp)

    @login_manager.user_loader
    def load_user(user_id: str):
        try:
            return db.session.get(User, int(user_id))
        except (TypeError, ValueError):
            return None

    @login_manager.unauthorized_handler
    def unauthorized():
        return jsonify({"ok": False, "error": "Avval tizimga kiring.", "code": "AUTH_REQUIRED"}), 401

    @app.before_request
    def protect_mutations():
        if request.path.startswith("/api/"):
            csrf_protect()

    @app.after_request
    def security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("Permissions-Policy", "camera=(self), geolocation=(self), microphone=(self)")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; "
            "font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        )
        if request.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        if app.config["APP_ENV"] == "production" and app.config["SESSION_COOKIE_SECURE"]:
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        return response

    @app.get("/")
    @app.get("/index.html")
    @app.get("/1_BOSING_MARJON_DMED.html")  # eski havola bilan moslik
    @app.get("/1_BOSING_PHARM360_DMED.html")
    def index():
        return send_file(Path(app.root_path).parent / "templates" / "index.html")

    @app.get("/manifest.webmanifest")
    def manifest():
        return send_from_directory(app.static_folder, "manifest.webmanifest", mimetype="application/manifest+json")

    @app.get("/service-worker.js")
    def service_worker():
        response = send_from_directory(app.static_folder, "service-worker.js", mimetype="application/javascript")
        response.headers["Cache-Control"] = "no-cache"
        response.headers["Service-Worker-Allowed"] = "/"
        return response

    @app.get("/offline.html")
    def offline():
        return send_from_directory(app.static_folder, "offline.html")

    @app.get("/assets/<path:filename>")
    def assets(filename: str):
        return send_from_directory(Path(app.static_folder) / "assets", filename)

    @app.errorhandler(400)
    def bad_request(error):
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "error": getattr(error, "description", "Noto‘g‘ri so‘rov.")}), 400
        return error

    @app.errorhandler(404)
    def not_found(error):
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "error": "Ma’lumot topilmadi."}), 404
        return send_file(Path(app.root_path).parent / "templates" / "index.html"), 404

    @app.errorhandler(413)
    def too_large(error):
        return jsonify({"ok": False, "error": "Fayl hajmi ruxsat etilgan chegaradan katta."}), 413

    @app.errorhandler(500)
    def server_error(error):
        db.session.rollback()
        app.logger.exception("Server error: %s", error)
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "error": "Serverda xatolik yuz berdi. Qayta urinib ko‘ring."}), 500
        return "Server xatosi", 500

    @app.cli.command("init-db")
    def init_db_command():
        db.create_all()
        seed_catalog()
        created = seed_users()
        click.echo("Ma’lumotlar bazasi tayyor.")
        for item in created:
            click.echo(f"Yaratildi: {item}")

    @app.cli.command("create-user")
    @click.option("--name", prompt=True)
    @click.option("--phone", prompt=True)
    @click.option("--role", type=click.Choice(["patient", "pharmacist", "courier", "accountant", "manager", "admin"]), prompt=True)
    @click.password_option()
    def create_user_command(name: str, phone: str, role: str, password: str):
        phone = normalize_phone(phone)
        ok, message = validate_password(password)
        if not ok:
            raise click.ClickException(message)
        if User.query.filter_by(phone=phone).first():
            raise click.ClickException("Bu telefon allaqachon mavjud.")
        user = User(name=name.strip(), phone=phone, role=role)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()
        click.echo(f"Foydalanuvchi yaratildi: {name} ({role})")

    with app.app_context():
        db.create_all()
        seed_catalog()
        created = seed_users()
        if created:
            app.logger.warning("Boshlang‘ich foydalanuvchilar yaratildi: %s", ", ".join(created))
        if app.config["APP_ENV"] == "production":
            secret_key = str(app.config["SECRET_KEY"] or "")
            if len(secret_key) < 32 or secret_key in {"dev-only-change-this-secret", "PASTGA_YANGI_UZUN_MAXFIY_KALIT_QOYING"}:
                raise RuntimeError("Production rejimida kamida 32 belgili yangi SECRET_KEY majburiy.")
            encryption_key = str(app.config["DATA_ENCRYPTION_KEY"] or "")
            if not encryption_key:
                raise RuntimeError("Production rejimida alohida DATA_ENCRYPTION_KEY majburiy.")
            try:
                Fernet(encryption_key.encode("ascii"))
            except (ValueError, TypeError):
                raise RuntimeError("DATA_ENCRYPTION_KEY haqiqiy Fernet kaliti emas.")
            if app.config["SQLALCHEMY_DATABASE_URI"].startswith("sqlite") and not app.config["ALLOW_PRODUCTION_SQLITE"]:
                raise RuntimeError("Production uchun PostgreSQL DATABASE_URL kiriting; SQLite serverda ma’lumot yo‘qotishi mumkin.")
            if not app.config["ADMIN_PASSWORD"]:
                raise RuntimeError("Production rejimida ADMIN_PASSWORD majburiy.")
            password_ok, password_message = validate_password(app.config["ADMIN_PASSWORD"])
            if not password_ok:
                raise RuntimeError(f"ADMIN_PASSWORD xavfsiz emas: {password_message}")

    return app
