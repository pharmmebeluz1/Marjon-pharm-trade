# Marjon Farm Trade — Secure Server Edition 8.0

Bu loyiha avvalgi chiroyli PWA shablonini saqlab, uning tagiga haqiqiy Flask serveri, umumiy ma’lumotlar bazasi, xavfsiz login, rollar, buyurtma jarayoni, kuryer GPS kuzatuvi, yopiq retsept fayllari va haqiqiy `.xlsx` hisobot qo‘shilgan versiya.

## Tuzatilgan asosiy kamchiliklar

- Buyurtmalar endi `localStorage`da emas, server bazasida saqlanadi.
- Bemor, farmatsevt, kuryer, buxgalter va rahbar rollari alohida ruxsat bilan ishlaydi.
- Parollar ochiq matnda saqlanmaydi; `scrypt` xeshi ishlatiladi.
- Sog‘liq pasporti serverda Fernet bilan shifrlanadi.
- Retsept rasmlari ochiq `static` papkaga emas, yopiq `instance/uploads` papkasiga tushadi.
- Kuryer GPS koordinatasi bir telefondan serverga yuborilib, bemorning boshqa telefonida yangilanadi.
- Ombor qoldig‘i buyurtma jarayoniga bog‘langan; bekor qilinganda qoldiq qaytariladi.
- Narx va tannarx brauzerga ishonib emas, serverdagi mahsulot kartasidan hisoblanadi.
- Buxgalter hisoboti haqiqiy Excel `.xlsx` faylida yaratiladi.
- APIlarda CSRF himoyasi, rol tekshiruvi, xavfsizlik sarlavhalari, audit jurnali va kirish urinishlari cheklovi bor.
- Service Worker maxfiy `/api/` javoblarini keshga saqlamaydi.

## Lokal kompyuterda ishga tushirish

Windows CMD yoki PowerShellda loyiha papkasiga kiring:

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
python app.py
```

Brauzerda oching:

```text
http://127.0.0.1:5000
```

### Development demo loginlari

`.env` ichida xodim parollari bo‘sh va `APP_ENV=development` bo‘lsa, quyidagi vaqtinchalik loginlar yaratiladi:

| Kabinet | Telefon | Vaqtinchalik parol |
|---|---|---|
| Rahbar | +998900000000 | Marjon2026! |
| Farmatsevt | +998900000001 | Farm2026! |
| Kuryer | +998900000002 | Kuryer2026! |
| Buxgalter | +998900000003 | Hisob2026! |

Birinchi kirishda dastur parolni almashtirishni talab qiladi. Bemor kabinetida esa foydalanuvchi o‘zi ro‘yxatdan o‘tadi.

## Maxfiy kalitlarni yaratish

`SECRET_KEY` uchun:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

`DATA_ENCRYPTION_KEY` uchun:

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Natijalarni `.env` ichiga joylang. `.env` faylini GitHubga yuklamang.

## Render serveriga joylash

1. Ushbu papkadagi barcha fayllarni yangi GitHub repositoriyga yuklang.
2. Render’da **New → Blueprint** tanlab, repositoriyga ulang.
3. `render.yaml` web server va PostgreSQL bazasini yaratadi.
4. Render Environment bo‘limida quyidagilarni kiriting:
   - `DATA_ENCRYPTION_KEY`
   - `ADMIN_PASSWORD`
   - `PHARMACIST_PASSWORD`
   - `COURIER_PASSWORD`
   - `ACCOUNTANT_PASSWORD`
5. Deploy qiling va `/api/health` manzilida `ok: true` chiqishini tekshiring.

Production rejimi maxfiy kalitlar yoki PostgreSQL bo‘lmasa ataylab ishga tushmaydi. Bu tasodifan himoyasiz server ochilib qolmasligi uchun qilingan.

## SMS, Click, Payme, DMED va AI

Quyidagi xizmatlar tashqi shartnoma, rasmiy API kaliti yoki merchant ma’lumotlarisiz haqiqiy ishlay olmaydi:

- **SMS:** `SMS_WEBHOOK_URL` va `SMS_WEBHOOK_TOKEN` orqali provayderga ulanadi. `REQUIRE_SMS_OTP=true` qilingandan keyin ro‘yxatdan o‘tishda SMS-kod majburiy bo‘ladi.
- **Click/Payme:** buyurtma saqlanadi, ammo merchant kalitlari ulanmaguncha dastur to‘lovni “muvaffaqiyatli” deb ko‘rsatmaydi.
- **DMED:** hozirgi DMED oynasi faqat ko‘rgazmali demo. Rasmiy integratsiya uchun DMED tomonidan berilgan hujjat va ruxsat kerak.
- **AI:** xavfli alomatlarda 103ga yo‘naltiradigan mahalliy xavfsiz javoblar bor. Haqiqiy AI xizmatini `AI_WEBHOOK_URL` orqali ulash mumkin. U tashxis qo‘ymaydi va dori tayinlamaydi.

## Kuryer GPS ishlashi

1. Farmatsevt buyurtmani tayyorlaydi va kuryerga biriktiradi.
2. Kuryer o‘z kabinetida **GPS boshlash** tugmasini bosadi va telefonda lokatsiyaga ruxsat beradi.
3. Koordinata serverga yuboriladi.
4. Bemor o‘z kabinetidagi **Jonli xarita** tugmasini ochadi.
5. Holat, masofa va taxminiy vaqt 3 soniyada yangilanadi.

Brauzer GPS va musiqa uchun foydalanuvchining birinchi bosishini talab qilishi mumkin. Bu telefon brauzerining xavfsizlik qoidasi; dastur uni yashirincha chetlab o‘tmaydi.

## Test

```bash
pytest -q
```

Testlar login, buyurtma, ombor, status, kuryer GPS, shifrlangan sog‘liq pasporti, maxfiy kuzatuv va Excel hisobotni tekshiradi.

## Muhim production vazifalari

Haqiqiy bemor ma’lumotlari bilan ishlashdan oldin HTTPS, kundalik backup, server monitoringi, loglarni himoyalash, foydalanuvchi roziligi matni, maxfiylik siyosati va mahalliy qonuniy talablar bo‘yicha mutaxassis tekshiruvi kerak.
