from marjon_app import create_app

# Render yoki lokal ishga tushirish uchun Flask ilovasi.
# /mijoz yo'nalishi marjon_app/__init__.py ichida ro'yxatdan o'tgan.
app = create_app()


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=5000,
        debug=app.config.get("APP_ENV") != "production",
    )
