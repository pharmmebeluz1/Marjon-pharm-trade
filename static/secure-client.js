(function () {
  "use strict";

  var state = {
    user: null,
    csrf: "",
    environment: "development",
    requireOtp: false,
    activeRole: "patient",
    requestedRole: "patient",
    products: [],
    branches: [],
    orders: [],
    couriers: [],
    gpsWatchId: null,
    gpsOrderCode: null,
    trackerTimer: null,
    trackerCode: null,
    trackerToken: "",
    checkoutLocation: null,
    authMode: "login",
    vault: {reminders: [], family_members: [], reservations: []},
    vaultTimer: null
  };

  var roleLabels = {
    patient: "Bemor",
    pharmacist: "Farmatsevt",
    courier: "Kuryer",
    accountant: "Buxgalter",
    manager: "Rahbar",
    admin: "Administrator"
  };

  function el(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>\"]/g, function (char) {
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[char];
    });
  }
  function money(value) {
    try { return new Intl.NumberFormat("uz-UZ").format(Number(value) || 0) + " so‘m"; }
    catch (e) { return String(value || 0) + " so‘m"; }
  }
  function toast(message, type) {
    if (window.marjonShowToast) window.marjonShowToast(message, type || "");
    else alert(message);
  }
  function statusClass(status) {
    if (status === "Yetkazildi") return "delivered";
    if (status === "Bekor qilindi" || status === "Yetkazilmadi") return "cancelled";
    if (status === "Kuryerga berildi" || status === "Yetkazilmoqda") return "delivery";
    if (status === "Yangi" || status === "Tasdiqlandi" || status === "Tayyorlanmoqda") return "pending";
    return "";
  }
  function showModal(id) {
    if (typeof window.openModal === "function") window.openModal(id);
    else if (el(id)) el(id).className = "modal open";
  }
  function hideModal(id) {
    if (typeof window.closeModal === "function") window.closeModal(id);
    else if (el(id)) el(id).className = "modal";
  }
  function setMessage(target, message, type) {
    var box = typeof target === "string" ? el(target) : target;
    if (!box) return;
    box.className = "secure-message " + (type || "");
    box.textContent = message;
  }
  function isMutation(method) {
    return !["GET", "HEAD", "OPTIONS"].includes((method || "GET").toUpperCase());
  }

  async function ensureCsrf() {
    if (state.csrf) return state.csrf;
    var response = await fetch("/api/auth/csrf", {credentials: "same-origin", cache: "no-store"});
    var data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "CSRF token olinmadi.");
    state.csrf = data.csrf_token;
    return state.csrf;
  }

  async function api(path, options) {
    options = options || {};
    var method = (options.method || "GET").toUpperCase();
    var headers = Object.assign({"Accept": "application/json"}, options.headers || {});
    if (isMutation(method)) headers["X-CSRF-Token"] = await ensureCsrf();
    if (options.body && !(options.body instanceof FormData) && typeof options.body !== "string") {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    var response = await fetch(path, Object.assign({}, options, {method: method, headers: headers, credentials: "same-origin", cache: "no-store"}));
    var contentType = response.headers.get("content-type") || "";
    var data = contentType.indexOf("application/json") > -1 ? await response.json() : null;
    if (!response.ok) {
      var error = new Error((data && data.error) || ("Server xatosi: " + response.status));
      error.status = response.status;
      error.code = data && data.code;
      error.data = data;
      throw error;
    }
    return data;
  }

  function clearSensitiveDemoStorage() {
    [
      "marjonGlobalHealthPassport", "marjonHealthProfile", "marjonPatientProfileV1",
      "marjonPlatformOrdersV1", "marjonCourierTrackV1", "marjonReturnsV1",
      "marjonWowCart", "marjonFavorites", "marjonMedicineReminder", "marjonLastOrder",
      "marjonReminders", "marjonOrderHistory", "marjonFamilyMembers", "marjonReservations", "marjonDmedAudit"
    ].forEach(function (key) {
      try { localStorage.removeItem(key); } catch (e) {}
    });
  }

  function legacyHealthProfile(passport) {
    passport = passport || {};
    return {
      name: passport.name || "",
      age: passport.age || "",
      allergies: passport.allergy || "",
      medicines: passport.medicines || "",
      emergencyName: passport.emergency_name || "",
      emergencyPhone: passport.emergency_phone || ""
    };
  }

  function hydrateSmartData(passport, vault, orders) {
    state.vault = vault || {reminders: [], family_members: [], reservations: []};
    if (typeof window.marjonHydrateSmartData === "function") {
      window.marjonHydrateSmartData({
        health_profile: legacyHealthProfile(passport),
        vault: state.vault,
        orders: (orders || []).map(function (order) {
          return {code:order.code, date:order.date || order.created, status:order.status, total:order.total};
        })
      });
    }
  }

  async function syncPatientData(knownOrders) {
    if (!state.user || state.user.role !== "patient") {
      hydrateSmartData({}, {reminders: [], family_members: [], reservations: []}, []);
      return;
    }
    var results = await Promise.all([
      api("/api/health-passport"),
      api("/api/patient-vault"),
      knownOrders ? Promise.resolve({orders:knownOrders}) : api("/api/orders")
    ]);
    hydrateSmartData(results[0].passport || {}, results[1].vault || {}, results[2].orders || []);
  }

  window.marjonSecureVaultSave = function (key, value) {
    if (!state.user || state.user.role !== "patient") {
      toast("Eslatma va oila ma’lumotlarini saqlash uchun bemor hisobiga kiring.", "warn");
      return;
    }
    var map = {marjonReminders:"reminders", marjonFamilyMembers:"family_members", marjonReservations:"reservations"};
    var field = map[key];
    if (!field) return;
    state.vault[field] = Array.isArray(value) ? value : [];
    if (state.vaultTimer) clearTimeout(state.vaultTimer);
    state.vaultTimer = setTimeout(async function () {
      try {
        var result = await api("/api/patient-vault", {method:"PUT", body:state.vault});
        state.vault = result.vault || state.vault;
      } catch (error) {
        toast("Xavfsiz saqlashda xato: " + error.message, "error");
      }
    }, 250);
  };

  async function refreshMe() {
    var data = await api("/api/auth/me");
    state.user = data.user;
    state.csrf = data.csrf_token || state.csrf;
    state.environment = data.environment || "development";
    state.requireOtp = !!data.require_sms_otp;
    return data;
  }

  function allowedRole(role) {
    if (!state.user) return false;
    if (state.user.role === "admin") return true;
    if (state.user.role === "manager") return role === "manager" || role === "accountant";
    return state.user.role === role;
  }

  function updateRoleTabs() {
    document.querySelectorAll("[data-platform-tab]").forEach(function (button) {
      var role = button.getAttribute("data-platform-tab");
      button.classList.toggle("active", role === state.activeRole);
      button.classList.toggle("secure-forbidden", !!state.user && !allowedRole(role));
    });
  }

  function userBar() {
    if (!state.user) return "";
    var icon = {patient:"👤",pharmacist:"⚕",courier:"🛵",accountant:"📊",manager:"◉",admin:"🔐"}[state.user.role] || "👤";
    return '<div class="secure-user-bar"><div class="secure-user-info"><span class="secure-user-avatar">'+icon+'</span><div><b>'+esc(state.user.name)+'</b><small>'+esc(roleLabels[state.user.role] || state.user.role)+' · '+esc(state.user.phone)+'</small></div></div><div class="secure-user-actions"><button class="secure-secondary" data-secure-action="change-password" type="button">Parolni almashtirish</button><button class="secure-danger" data-secure-action="logout" type="button">Chiqish</button></div></div>';
  }

  function authHtml(role) {
    var registration = state.authMode === "register";
    var roleText = roleLabels[role] || "Kabinet";
    var demo = state.environment !== "production" ? '<div class="secure-demo-accounts"><b>Mahalliy demo hisoblar:</b><br>Rahbar: <code>+998900000000 / Marjon2026!</code><br>Farmatsevt: <code>+998900000001 / Farm2026!</code><br>Kuryer: <code>+998900000002 / Kuryer2026!</code><br>Buxgalter: <code>+998900000003 / Hisob2026!</code><br><small>Birinchi kirishda parolni almashtirish so‘ralishi mumkin.</small></div>' : "";
    var registerSwitch = role === "patient" ? '<button type="button" data-auth-mode="register" class="'+(registration?'active':'')+'">Ro‘yxatdan o‘tish</button>' : '<button type="button" disabled>Faqat rahbar yaratadi</button>';
    var otpBlock = state.requireOtp ? '<label><span>SMS kodi</span><div class="secure-otp-row"><input id="secureOtp" inputmode="numeric" maxlength="6" placeholder="6 xonali kod"><button class="secure-secondary" type="button" data-secure-action="request-otp">Kod olish</button></div></label>' : "";
    return '<div class="secure-auth-card"><div class="secure-auth-head"><div><h3>'+esc(roleText)+' kabinetiga xavfsiz kirish</h3><p>Parol serverda xesh holatda saqlanadi. Har bir rol faqat o‘z ma’lumotlarini ko‘radi.</p></div><span class="secure-badge locked">🔒 HIMOYALANGAN</span></div><div class="secure-auth-switch"><button type="button" data-auth-mode="login" class="'+(!registration?'active':'')+'">Kirish</button>'+registerSwitch+'</div>'+(registration ? '<form id="secureRegisterForm" class="secure-form"><label><span>Ism va familiya</span><input id="secureRegName" autocomplete="name" required></label><div class="secure-form-row"><label><span>Telefon</span><input id="secureRegPhone" type="tel" placeholder="+998901234567" autocomplete="tel" required></label><label><span>Til</span><select id="secureRegLang"><option value="uz">O‘zbek</option><option value="ru">Русский</option><option value="en">English</option></select></label></div><label><span>Manzil</span><input id="secureRegAddress" placeholder="Yetkazib berish manzili"></label><label><span>Parol</span><input id="secureRegPassword" type="password" minlength="8" autocomplete="new-password" required></label>'+otpBlock+'<label class="secure-check"><input id="secureRegConsent" type="checkbox" required><span>Shaxsiy ma’lumotlarni buyurtma va yetkazib berish uchun qayta ishlashga roziman.</span></label><button class="secure-primary" type="submit">Bemor hisobini yaratish</button><div id="secureAuthMessage"></div></form>' : '<form id="secureLoginForm" class="secure-form"><label><span>Telefon</span><input id="secureLoginPhone" type="tel" placeholder="+998901234567" autocomplete="username" required></label><label><span>Parol</span><input id="secureLoginPassword" type="password" autocomplete="current-password" required></label><label class="secure-check"><input id="secureRemember" type="checkbox"><span>Bu qurilmada kirishni eslab qolish</span></label><button class="secure-primary" type="submit">Kirish</button><div id="secureAuthMessage"></div></form>')+demo+'</div>';
  }

  function passwordChangeHtml() {
    return userBar() + '<div class="secure-auth-card"><div class="secure-auth-head"><div><h3>Parolni almashtiring</h3><p>Vaqtinchalik yoki eski parol o‘rniga kuchli yangi parol o‘rnating.</p></div><span class="secure-badge locked">🔑 MAJBURIY</span></div><form id="securePasswordForm" class="secure-form"><label><span>Joriy parol</span><input id="secureCurrentPassword" type="password" required></label><label><span>Yangi parol</span><input id="secureNewPassword" type="password" minlength="8" required></label><label><span>Yangi parolni takrorlang</span><input id="secureNewPassword2" type="password" minlength="8" required></label><button class="secure-primary" type="submit">Parolni saqlash</button><div id="secureAuthMessage"></div></form></div>';
  }

  async function openRole(role) {
    state.requestedRole = role || "patient";
    state.activeRole = state.requestedRole;
    showModal("platformModal");
    updateRoleTabs();
    await renderActiveRole();
  }

  async function renderActiveRole() {
    var content = el("platformContent");
    if (!content) return;
    if (el("platformModalTitle")) el("platformModalTitle").textContent = (roleLabels[state.activeRole] || "Kabinet") + " kabineti";
    content.innerHTML = '<div class="secure-loading">Ma’lumotlar olinmoqda…</div>';
    if (!state.user) {
      content.innerHTML = authHtml(state.activeRole);
      bindContentEvents();
      return;
    }
    if (state.user.must_change_password) {
      content.innerHTML = passwordChangeHtml();
      bindContentEvents();
      return;
    }
    if (!allowedRole(state.activeRole)) {
      content.innerHTML = userBar() + '<div class="secure-message warn">Siz '+esc(roleLabels[state.user.role] || state.user.role)+' sifatida kirgansiz. '+esc(roleLabels[state.activeRole])+' kabinetiga ruxsat yo‘q.</div>';
      bindContentEvents();
      return;
    }
    try {
      if (state.activeRole === "patient") await renderPatient();
      else if (state.activeRole === "pharmacist") await renderPharmacist();
      else if (state.activeRole === "courier") await renderCourier();
      else if (state.activeRole === "accountant") await renderAccountant();
      else await renderManager();
    } catch (error) {
      content.innerHTML = userBar() + '<div class="secure-message error">'+esc(error.message)+'</div>';
    }
    bindContentEvents();
  }

  function orderItems(order) {
    return (order.items || []).map(function (item) { return esc(item.name) + " × " + esc(item.qty); }).join(", ") || "Mahsulot";
  }

  function orderTable(orders, role) {
    if (!orders.length) return '<div class="secure-empty">Buyurtmalar topilmadi.</div>';
    var rows = orders.map(function (order) {
      var actions = "";
      if (role === "patient") {
        actions = '<button class="secure-mini" data-secure-action="track" data-code="'+esc(order.code)+'" data-token="'+esc(order.tracking_token || "")+'">Jonli xarita</button>';
      } else if (role === "pharmacist" || role === "manager") {
        var next = [];
        if (order.status === "Yangi") next.push(["Tasdiqlandi", "Tasdiqlash"]);
        if (order.status === "Tasdiqlandi") next.push(["Tayyorlanmoqda", "Tayyorlash"]);
        if (order.status === "Tayyorlanmoqda") next.push(["Tayyor", "Tayyor"]);
        if (["Yangi","Tasdiqlandi","Tayyorlanmoqda","Tayyor"].includes(order.status)) next.push(["Bekor qilindi", "Bekor"]);
        actions = next.map(function (item) { return '<button class="secure-mini" data-secure-action="status" data-code="'+esc(order.code)+'" data-status="'+esc(item[0])+'">'+esc(item[1])+'</button>'; }).join("");
        if (["Tayyor", "Tayyorlanmoqda"].includes(order.status)) {
          actions += '<select data-courier-select="'+esc(order.code)+'"><option value="">Kuryer tanlang</option>'+state.couriers.map(function (courier) { return '<option value="'+courier.id+'">'+esc(courier.name)+'</option>'; }).join("")+'</select><button class="secure-mini" data-secure-action="assign" data-code="'+esc(order.code)+'">Biriktirish</button>';
        }
        actions += '<button class="secure-mini" data-secure-action="track" data-code="'+esc(order.code)+'" data-token="'+esc(order.tracking_token || "")+'">Xarita</button>';
      } else if (role === "courier") {
        if (["Kuryerga berildi", "Yetkazilmoqda"].includes(order.status)) {
          actions += '<button class="secure-mini" data-secure-action="gps-start" data-code="'+esc(order.code)+'">GPS boshlash</button><button class="secure-mini" data-secure-action="track" data-code="'+esc(order.code)+'" data-token="'+esc(order.tracking_token || "")+'">Xarita</button><button class="secure-mini" data-secure-action="status" data-code="'+esc(order.code)+'" data-status="Yetkazildi">Yetkazildi</button><button class="secure-mini" data-secure-action="status" data-code="'+esc(order.code)+'" data-status="Yetkazilmadi">Yetkazilmadi</button>';
        }
      }
      var customerLabel = order.customer || (role === "accountant" ? "Shaxsiy ma’lumot yopiq" : state.user.name);
      return '<tr><td><b>'+esc(order.code)+'</b><small>'+esc(order.date || order.created)+'</small></td><td><b>'+esc(customerLabel)+'</b><small>'+esc(order.phone || "")+'</small></td><td>'+orderItems(order)+'</td><td><b>'+money(order.total)+'</b><small>'+esc(order.payment)+' · '+esc(order.payment_status || "pending")+'</small></td><td>'+esc(order.address || order.branch_name || order.branch)+'</td><td><span class="secure-status '+statusClass(order.status)+'">'+esc(order.status)+'</span><small>'+esc(order.courier || "")+'</small></td><td><div class="secure-actions">'+actions+'</div></td></tr>';
    }).join("");
    return '<div class="secure-table-wrap"><table class="secure-table"><thead><tr><th>KOD / SANA</th><th>BEMOR</th><th>MAHSULOTLAR</th><th>TO‘LOV</th><th>MANZIL</th><th>HOLAT</th><th>AMAL</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  }

  async function loadOrders() {
    var data = await api("/api/orders");
    state.orders = data.orders || [];
    return state.orders;
  }

  async function renderPatient() {
    var orders = await loadOrders();
    await syncPatientData(orders);
    var content = el("platformContent");
    content.innerHTML = userBar() + '<div class="secure-stats"><div class="secure-stat"><span>Buyurtmalar</span><strong>'+orders.length+'</strong><small>Server bazasida</small></div><div class="secure-stat"><span>Yo‘ldagi</span><strong>'+orders.filter(function(o){return ["Kuryerga berildi","Yetkazilmoqda"].includes(o.status);}).length+'</strong><small>Jonli kuzatuv</small></div><div class="secure-stat"><span>Yetkazilgan</span><strong>'+orders.filter(function(o){return o.status==="Yetkazildi";}).length+'</strong><small>Yakunlangan</small></div><div class="secure-stat"><span>Til</span><strong>'+esc((state.user.language || "uz").toUpperCase())+'</strong><small>Shaxsiy sozlama</small></div></div><div class="secure-panel"><div class="secure-panel-head"><div><h3>Mening buyurtmalarim</h3><p>Buyurtma, to‘lov va kuryer holati serverdan olinadi.</p></div><div class="secure-user-actions"><button class="secure-secondary" data-secure-action="catalog">Katalog</button><button class="secure-secondary" data-secure-action="passport">Sog‘liq pasporti</button></div></div>'+orderTable(orders, "patient")+'</div>';
  }

  async function renderPharmacist() {
    var results = await Promise.all([api("/api/orders"), api("/api/users?role=courier"), api("/api/prescriptions")]);
    state.orders = results[0].orders || [];
    state.couriers = results[1].users || [];
    var prescriptions = results[2].prescriptions || [];
    var rxHtml = prescriptions.length ? prescriptions.map(function (rx) {
      return '<div class="secure-prescription"><div><b>'+esc(rx.code)+' · '+esc(rx.patient)+'</b><small>'+esc(rx.branch)+' · '+esc(rx.filename)+' · '+esc(rx.status)+'</small></div><div class="secure-actions"><a class="secure-mini" target="_blank" href="/api/prescriptions/'+rx.id+'/file">Fayl</a><button class="secure-mini" data-secure-action="rx-status" data-id="'+rx.id+'" data-status="Tekshirilmoqda">Tekshirish</button><button class="secure-mini" data-secure-action="rx-status" data-id="'+rx.id+'" data-status="Tasdiqlandi">Tasdiqlash</button></div></div>';
    }).join("") : '<div class="secure-empty">Yangi retsept yo‘q.</div>';
    el("platformContent").innerHTML = userBar() + '<div class="secure-grid"><div class="secure-panel"><div class="secure-panel-head"><div><h3>Buyurtmalar</h3><p>Qoldiq serverda tekshiriladi, keyin holat o‘zgartiriladi.</p></div><span class="secure-badge"><span class="secure-online-dot"></span> ONLAYN</span></div>'+orderTable(state.orders, "pharmacist")+'</div><div class="secure-panel"><h3 class="secure-section-title">Elektron retseptlar</h3>'+rxHtml+'</div></div>';
  }

  async function renderCourier() {
    var orders = await loadOrders();
    el("platformContent").innerHTML = userBar() + '<div class="secure-panel"><div class="secure-panel-head"><div><h3>Menga biriktirilgan yetkazmalar</h3><p>GPS faqat siz tugmani bosganingizdan keyin va brauzer ruxsati bilan uzatiladi.</p></div>'+(state.gpsWatchId !== null ? '<button class="secure-danger" data-secure-action="gps-stop">GPSni to‘xtatish</button>' : '<span class="secure-badge">📍 HTTPS TALAB QILINADI</span>')+'</div>'+orderTable(orders, "courier")+'<div id="secureGpsMessage" class="secure-message">GPS boshlanganda bemor boshqa telefondan ham kuryer joylashuvini ko‘radi.</div></div>';
  }

  async function renderAccountant() {
    var results = await Promise.all([api("/api/orders"), api("/api/dashboard")]);
    state.orders = results[0].orders || [];
    var stats = results[1].stats || {};
    el("platformContent").innerHTML = userBar() + '<div class="secure-stats"><div class="secure-stat"><span>Savdo</span><strong>'+money(stats.sales)+'</strong><small>Bekor qilinmagan</small></div><div class="secure-stat"><span>Tannarx</span><strong>'+money(stats.cost)+'</strong><small>Mahsulot kartasidan</small></div><div class="secure-stat"><span>Foyda</span><strong>'+money(stats.profit)+'</strong><small>Server hisoblagan</small></div><div class="secure-stat"><span>Buyurtmalar</span><strong>'+esc(stats.orders)+'</strong><small>Tanlangan davr</small></div></div><div class="secure-panel"><div class="secure-panel-head"><div><h3>Moliyaviy hisobot</h3><p>Haqiqiy .xlsx fayl serverdagi ma’lumotlardan yaratiladi.</p></div><button class="secure-primary" data-secure-action="excel">Excel yuklash</button></div>'+orderTable(state.orders, "accountant")+'</div>';
  }

  async function renderManager() {
    var results = await Promise.all([api("/api/orders"), api("/api/dashboard"), api("/api/stock"), api("/api/audit")]);
    state.orders = results[0].orders || [];
    var stats = results[1].stats || {};
    var stock = results[2].stock || [];
    var logs = results[3].logs || [];
    try { state.couriers = (await api("/api/users?role=courier")).users || []; } catch (e) { state.couriers = []; }
    var stockHtml = stock.filter(function (row) { return row.low; }).slice(0, 30).map(function (row) {
      return '<div class="secure-stock-row '+(row.low?'low':'')+'"><div><b>'+esc(row.product)+'</b><small>'+esc(row.branch)+'</small></div><span>'+row.quantity+' dona</span><input type="number" min="0" value="'+row.quantity+'" data-stock-input="'+row.id+'"><button class="secure-mini" data-secure-action="stock-save" data-id="'+row.id+'">Saqlash</button></div>';
    }).join("") || '<div class="secure-empty">Kam qolgan mahsulot yo‘q.</div>';
    var auditHtml = logs.slice(0, 80).map(function (log) { return '<div class="secure-audit-row"><b>'+esc(log.action)+' · '+esc(log.user)+'</b><small>'+esc(log.entity_type)+' '+esc(log.entity_id)+' · '+esc(log.created_at)+'</small><small>'+esc(log.detail)+'</small></div>'; }).join("");
    el("platformContent").innerHTML = userBar() + '<div class="secure-stats"><div class="secure-stat"><span>Savdo</span><strong>'+money(stats.sales)+'</strong><small>Server bazasi</small></div><div class="secure-stat"><span>Foyda</span><strong>'+money(stats.profit)+'</strong><small>Haqiqiy tannarx</small></div><div class="secure-stat"><span>Kam qoldiq</span><strong>'+esc(stats.low_stock)+'</strong><small>Ombor ogohlantirishi</small></div><div class="secure-stat"><span>Yo‘ldagi kuryer</span><strong>'+esc(stats.active_delivery)+'</strong><small>Faol yetkazmalar</small></div></div><div class="secure-grid"><div class="secure-panel"><div class="secure-panel-head"><div><h3>Barcha buyurtmalar</h3><p>Holat, kuryer va to‘lovlar nazorati.</p></div><button class="secure-primary" data-secure-action="excel">Excel</button></div>'+orderTable(state.orders, "manager")+'</div><div class="secure-stack"><div class="secure-panel"><h3 class="secure-section-title">Kam qolgan ombor</h3><div class="secure-stock-list">'+stockHtml+'</div></div><div class="secure-panel"><h3 class="secure-section-title">Audit jurnali</h3><div class="secure-audit">'+auditHtml+'</div></div></div></div>';
  }

  function bindContentEvents() {
    var content = el("platformContent");
    if (!content) return;
    content.onclick = async function (event) {
      var modeButton = event.target.closest("[data-auth-mode]");
      if (modeButton && !modeButton.disabled) {
        state.authMode = modeButton.getAttribute("data-auth-mode");
        content.innerHTML = authHtml(state.activeRole);
        bindContentEvents();
        return;
      }
      var button = event.target.closest("[data-secure-action]");
      if (!button) return;
      var action = button.getAttribute("data-secure-action");
      try {
        if (action === "logout") await logout();
        else if (action === "change-password") { content.innerHTML = passwordChangeHtml(); bindContentEvents(); }
        else if (action === "request-otp") await requestOtp();
        else if (action === "catalog") { hideModal("platformModal"); el("catalog").scrollIntoView({behavior:"smooth"}); }
        else if (action === "passport") { await openSecurePassport(); }
        else if (action === "track") openTracking(button.getAttribute("data-code"), button.getAttribute("data-token") || "");
        else if (action === "status") await updateStatus(button.getAttribute("data-code"), button.getAttribute("data-status"));
        else if (action === "assign") await assignCourier(button.getAttribute("data-code"));
        else if (action === "gps-start") startGps(button.getAttribute("data-code"));
        else if (action === "gps-stop") stopGps();
        else if (action === "excel") window.location.href = "/api/reports/orders.xlsx";
        else if (action === "stock-save") await saveStock(button.getAttribute("data-id"));
        else if (action === "rx-status") await updatePrescription(button.getAttribute("data-id"), button.getAttribute("data-status"));
      } catch (error) { toast(error.message, "error"); }
    };
    var loginForm = el("secureLoginForm");
    if (loginForm) loginForm.onsubmit = login;
    var registerForm = el("secureRegisterForm");
    if (registerForm) registerForm.onsubmit = register;
    var passwordForm = el("securePasswordForm");
    if (passwordForm) passwordForm.onsubmit = changePassword;
  }

  async function login(event) {
    event.preventDefault();
    try {
      var data = await api("/api/auth/login", {method:"POST", body:{phone:el("secureLoginPhone").value, password:el("secureLoginPassword").value, remember:el("secureRemember").checked}});
      state.user = data.user;
      state.csrf = data.csrf_token || state.csrf;
      state.activeRole = state.user.role === "admin" ? "manager" : state.user.role;
      toast("Tizimga muvaffaqiyatli kirdingiz.", "success");
      updateRoleTabs();
      await renderActiveRole();
    } catch (error) { setMessage("secureAuthMessage", error.message, "error"); }
  }

  async function register(event) {
    event.preventDefault();
    try {
      var data = await api("/api/auth/register", {method:"POST", body:{name:el("secureRegName").value, phone:el("secureRegPhone").value, password:el("secureRegPassword").value, language:el("secureRegLang").value, address:el("secureRegAddress").value, consent:el("secureRegConsent").checked, otp:el("secureOtp") ? el("secureOtp").value : "", latitude:state.checkoutLocation && state.checkoutLocation.lat, longitude:state.checkoutLocation && state.checkoutLocation.lon}});
      state.user = data.user;
      state.csrf = data.csrf_token || state.csrf;
      state.activeRole = "patient";
      toast("Bemor hisobi yaratildi.", "success");
      await renderActiveRole();
    } catch (error) { setMessage("secureAuthMessage", error.message, "error"); }
  }

  async function requestOtp() {
    var phone = el("secureRegPhone") && el("secureRegPhone").value;
    var data = await api("/api/auth/request-otp", {method:"POST", body:{phone:phone, purpose:"register"}});
    var message = data.message + (data.demo_code ? " Kod: " + data.demo_code : "");
    setMessage("secureAuthMessage", message, data.sent ? "success" : "warn");
    if (data.demo_code && el("secureOtp")) el("secureOtp").value = data.demo_code;
  }

  async function logout() {
    await api("/api/auth/logout", {method:"POST", body:{}});
    state.user = null;
    state.csrf = "";
    hydrateSmartData({}, {reminders: [], family_members: [], reservations: []}, []);
    stopGps();
    state.authMode = "login";
    toast("Kabinetdan chiqdingiz.", "success");
    await refreshMe();
    await renderActiveRole();
  }

  async function changePassword(event) {
    event.preventDefault();
    var first = el("secureNewPassword").value;
    var second = el("secureNewPassword2").value;
    if (first !== second) { setMessage("secureAuthMessage", "Yangi parollar bir xil emas.", "error"); return; }
    try {
      var data = await api("/api/auth/change-password", {method:"POST", body:{current_password:el("secureCurrentPassword").value, new_password:first}});
      state.user = data.user;
      toast("Parol yangilandi.", "success");
      await renderActiveRole();
    } catch (error) { setMessage("secureAuthMessage", error.message, "error"); }
  }

  async function updateStatus(code, status) {
    await api("/api/orders/"+encodeURIComponent(code)+"/status", {method:"PATCH", body:{status:status}});
    toast("Buyurtma holati yangilandi: " + status, "success");
    await renderActiveRole();
  }

  async function assignCourier(code) {
    var select = document.querySelector('[data-courier-select="'+CSS.escape(code)+'"]');
    if (!select || !select.value) throw new Error("Kuryerni tanlang.");
    await api("/api/orders/"+encodeURIComponent(code)+"/assign-courier", {method:"PATCH", body:{courier_id:Number(select.value)}});
    toast("Kuryer buyurtmaga biriktirildi.", "success");
    await renderActiveRole();
  }

  async function updatePrescription(id, status) {
    await api("/api/prescriptions/"+encodeURIComponent(id), {method:"PATCH", body:{status:status}});
    toast("Retsept holati yangilandi.", "success");
    await renderActiveRole();
  }

  async function saveStock(id) {
    var input = document.querySelector('[data-stock-input="'+CSS.escape(String(id))+'"]');
    if (!input) return;
    await api("/api/stock/"+encodeURIComponent(id), {method:"PATCH", body:{quantity:Number(input.value)}});
    toast("Ombor qoldig‘i saqlandi.", "success");
    await syncCatalog();
    await renderActiveRole();
  }

  function startGps(code) {
    if (!navigator.geolocation) { toast("Bu brauzer GPSni qo‘llamaydi.", "error"); return; }
    stopGps();
    state.gpsOrderCode = code;
    state.gpsWatchId = navigator.geolocation.watchPosition(async function (position) {
      try {
        await api("/api/orders/"+encodeURIComponent(code)+"/courier-location", {method:"POST", body:{latitude:position.coords.latitude, longitude:position.coords.longitude, accuracy:position.coords.accuracy, heading:position.coords.heading, speed:position.coords.speed}});
        var box = el("secureGpsMessage");
        if (box) setMessage(box, "GPS serverga yuborildi: " + new Date().toLocaleTimeString("uz-UZ"), "success");
      } catch (error) {
        var box2 = el("secureGpsMessage");
        if (box2) setMessage(box2, error.message, "error");
      }
    }, function (error) {
      toast(error.code === 1 ? "GPS ruxsati berilmadi." : "GPS aniqlanmadi.", "error");
      stopGps();
    }, {enableHighAccuracy:true, maximumAge:3000, timeout:15000});
    toast("Jonli GPS uzatish boshlandi.", "success");
    renderActiveRole();
  }

  function stopGps() {
    if (state.gpsWatchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(state.gpsWatchId);
    state.gpsWatchId = null;
    state.gpsOrderCode = null;
  }

  async function openTracking(code, token) {
    state.trackerCode = code;
    state.trackerToken = token || "";
    showModal("courierTrackModal");
    if (state.trackerTimer) clearInterval(state.trackerTimer);
    await refreshTracking();
    state.trackerTimer = setInterval(refreshTracking, 3000);
  }

  function closeTracking() {
    if (state.trackerTimer) clearInterval(state.trackerTimer);
    state.trackerTimer = null;
    hideModal("courierTrackModal");
  }

  async function refreshTracking() {
    if (!state.trackerCode) return;
    try {
      var suffix = state.trackerToken ? "?token="+encodeURIComponent(state.trackerToken) : "";
      var data = await api("/api/orders/"+encodeURIComponent(state.trackerCode)+"/tracking"+suffix);
      var order = data.order || {};
      var loc = data.location;
      if (el("trackerTitle")) el("trackerTitle").textContent = order.code + " · " + order.status;
      if (el("trackerModeLabel")) el("trackerModeLabel").textContent = data.tracking_active ? "● JONLI KURYER KUZATUVI" : "● BUYURTMA HOLATI";
      if (el("trackerEta")) el("trackerEta").textContent = data.eta_minutes ? data.eta_minutes + " daqiqa" : "Kutilmoqda";
      if (el("trackerDistance")) el("trackerDistance").textContent = data.distance_km != null ? data.distance_km + " km" : "—";
      if (el("trackerAccuracy")) el("trackerAccuracy").textContent = loc && loc.accuracy ? "±"+Math.round(loc.accuracy)+" m" : "—";
      if (el("trackerSpeed")) el("trackerSpeed").textContent = loc && loc.speed != null ? Math.max(0, Math.round(loc.speed * 3.6)) + " km/soat" : "—";
      if (el("trackerLastUpdate")) el("trackerLastUpdate").textContent = loc ? new Date(loc.updated_at).toLocaleTimeString("uz-UZ") + " da yangilandi" : "GPS hali yuborilmagan";
      var courierName = document.querySelector("#courierTrackModal .courier-profile b");
      if (courierName) courierName.textContent = order.courier || "Kuryer biriktirilmagan";
      if (el("trackerCall")) {
        if (order.courier_phone) {
          el("trackerCall").href = "tel:" + order.courier_phone;
          el("trackerCall").removeAttribute("aria-disabled");
        } else {
          el("trackerCall").href = "#";
          el("trackerCall").setAttribute("aria-disabled", "true");
        }
      }
      var progress = data.distance_km == null ? 0 : Math.max(8, Math.min(96, 100 - data.distance_km * 12));
      if (order.status === "Yetkazildi") progress = 100;
      if (el("trackerProgressBar")) el("trackerProgressBar").style.width = progress + "%";
      if (el("courierMarker")) {
        el("courierMarker").style.left = (8 + progress * 0.78) + "%";
        el("courierMarker").style.top = (78 - progress * 0.55) + "%";
      }
      if (el("trackerTurnText")) el("trackerTurnText").textContent = loc ? "Kuryer GPS signali server orqali yangilanmoqda" : "Kuryer GPS uzatishni hali boshlamagan";
      if (el("trackerOrderData")) el("trackerOrderData").innerHTML = '<h3>Buyurtma ma’lumoti</h3><div class="tracker-order-line"><span>Kod</span><b>'+esc(order.code)+'</b></div><div class="tracker-order-line"><span>Holat</span><b>'+esc(order.status)+'</b></div><div class="tracker-order-line"><span>Kuryer</span><b>'+esc(order.courier || "Biriktirilmagan")+'</b></div><div class="tracker-order-line"><span>Manzil</span><b>'+esc(order.address || "")+'</b></div>'+(loc?'<a class="secure-track-map-link" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(loc.lat+","+loc.lon)+'">Kuryerni xaritada ochish</a>':'');
      if (el("trackerDemoNote")) el("trackerDemoNote").textContent = "Koordinata umumiy server bazasidan olinmoqda. Yangilanish oralig‘i: 3 soniya.";
    } catch (error) {
      if (el("trackerDemoNote")) el("trackerDemoNote").textContent = error.message;
    }
  }

  async function syncCatalog() {
    try {
      var results = await Promise.all([api("/api/products"), api("/api/branches")]);
      state.products = results[0].products || [];
      state.branches = results[1].branches || [];
      window.products = state.products;
      if (typeof window.marjonHydrateProductStock === "function") window.marjonHydrateProductStock(state.products, state.branches);
      window.branches = state.branches.map(function (branch) {
        return {id:branch.slug, city:branch.slug, name:branch.name, address:branch.address, phone:branch.phone, lat:branch.latitude, lon:branch.longitude};
      });
      window.renderProducts = renderServerProducts;
      renderServerProducts();
      if (typeof window.renderBranches === "function") window.renderBranches(window.branches);
    } catch (error) { console.warn("Catalog sync failed", error); }
  }

  function renderServerProducts() {
    var grid = el("productGrid");
    if (!grid) return;
    var category = window.selectedCategory || "all";
    var search = String(window.searchText || "").toLowerCase();
    var language = window.currentLang || "uz";
    var list = state.products.filter(function (product) {
      var text = (product.uz+" "+product.ru+" "+product.en+" "+product.sku).toLowerCase();
      return (category === "all" || product.category === category) && text.indexOf(search) !== -1;
    });
    grid.innerHTML = list.map(function (product) {
      var name = language === "ru" ? product.ru : (language === "en" ? product.en : product.uz);
      var total = Number(product.total_stock || 0);
      var favorite = window.favorites && window.favorites[product.id];
      return '<article class="product-card"><div class="product-image"><span class="product-badge">'+esc(product.badge)+'</span><button type="button" class="favorite-product '+(favorite?'active':'')+'" onclick="toggleFavorite('+product.id+')">'+(favorite?'♥':'♡')+'</button><div class="product-pack"><span>'+esc(product.emoji)+'</span><small>MARJON<br>FARM TRADE</small></div></div><div class="product-info"><small>'+esc(typeof window.getCategoryName === "function" ? window.getCategoryName(product.category) : product.category)+'</small><h3>'+esc(name)+'</h3><div class="product-stock-line"><span class="'+(total<15?'stock-low':'stock-number')+'">'+total+' dona mavjud</span><button type="button" data-stock-product="'+product.id+'">Filiallar</button></div><div class="price-row"><div><strong>'+money(product.price)+'</strong>'+(product.old?'<del>'+money(product.old)+'</del>':'')+'</div><button type="button" class="add-button" onclick="addToCart('+product.id+')">+</button></div></div></article>';
    }).join("");
    if (el("emptyState")) el("emptyState").className = list.length ? "empty-state hidden" : "empty-state";
    grid.querySelectorAll("[data-stock-product]").forEach(function (button) {
      button.onclick = function () {
        var product = state.products.find(function (item) { return String(item.id) === button.getAttribute("data-stock-product"); });
        if (!product) return;
        var detail = Object.keys(product.stock || {}).map(function (slug) {
          var branch = state.branches.find(function (item) { return item.slug === slug; });
          return (branch ? branch.city : slug) + ": " + product.stock[slug] + " dona";
        }).join(" · ");
        toast(detail || "Qoldiq topilmadi.", "success");
      };
    });
  }

  function cartItemsFromWindow() {
    var items = [];
    var cart = window.cart || {};
    Object.keys(cart).forEach(function (id) {
      var product = state.products.find(function (item) { return String(item.id) === String(id); });
      if (product) items.push({id:product.id, qty:Number(cart[id]) || 1});
    });
    return items;
  }

  async function securePlaceOrder() {
    var status = el("checkoutStatus");
    if (!state.user || state.user.role !== "patient") {
      hideModal("checkoutModal");
      state.authMode = "login";
      await openRole("patient");
      toast("Buyurtma berish uchun bemor hisobiga kiring.", "warn");
      return;
    }
    var items = cartItemsFromWindow();
    var address = el("checkoutAddress").value.trim();
    if (!items.length || !address || !el("checkoutConsent").checked) {
      status.className = "status error";
      status.textContent = "Savat, manzil va tasdiqlash belgisini tekshiring.";
      return;
    }
    var branch = nearestBranchSlug(address);
    try {
      status.className = "status";
      status.textContent = "Buyurtma serverga yuborilmoqda…";
      var data = await api("/api/orders", {method:"POST", body:{items:items, address:address, method:el("checkoutMethod").value, payment:el("checkoutPayment").value, branch:branch, latitude:state.checkoutLocation && state.checkoutLocation.lat, longitude:state.checkoutLocation && state.checkoutLocation.lon, consent:true}});
      window.cart = {};
      if (typeof window.saveCart === "function") window.saveCart();
      status.className = "status";
      status.innerHTML = '<b>Buyurtma serverga saqlandi.</b><br>Kuzatuv kodi: '+esc(data.order.code)+'<br>To‘lov holati: '+esc(data.order.payment_status);
      if (el("trackingCode")) el("trackingCode").value = data.order.code;
      toast("Buyurtma qabul qilindi: " + data.order.code, "success");
      setTimeout(function () { hideModal("checkoutModal"); }, 2200);
    } catch (error) {
      status.className = "status error";
      status.textContent = error.message;
    }
  }

  function nearestBranchSlug(address) {
    var lower = String(address || "").toLowerCase();
    var found = state.branches.find(function (branch) { return lower.indexOf(branch.city.toLowerCase()) > -1 || lower.indexOf(branch.slug) > -1; });
    if (found) return found.slug;
    if (!state.checkoutLocation || !state.branches.length) return state.branches[0] ? state.branches[0].slug : "tashkent";
    var best = state.branches[0], bestDistance = Infinity;
    state.branches.forEach(function (branch) {
      var d = Math.pow(branch.latitude-state.checkoutLocation.lat,2)+Math.pow(branch.longitude-state.checkoutLocation.lon,2);
      if (d < bestDistance) { bestDistance = d; best = branch; }
    });
    return best.slug;
  }

  function getCheckoutLocation() {
    if (!navigator.geolocation) { toast("Bu brauzer lokatsiyani qo‘llamaydi.", "error"); return; }
    navigator.geolocation.getCurrentPosition(function (position) {
      state.checkoutLocation = {lat:Number(position.coords.latitude.toFixed(6)), lon:Number(position.coords.longitude.toFixed(6))};
      el("checkoutAddress").value = state.checkoutLocation.lat + ", " + state.checkoutLocation.lon;
      el("checkoutLocationNote").innerHTML = '<a target="_blank" rel="noopener" href="https://maps.google.com/?q='+state.checkoutLocation.lat+','+state.checkoutLocation.lon+'">Xaritada ko‘rish</a>';
      toast("Lokatsiya olindi.", "success");
    }, function () { toast("Lokatsiyaga ruxsat berilmadi.", "error"); }, {enableHighAccuracy:true, timeout:12000, maximumAge:30000});
  }

  async function securePrescription() {
    if (!state.user || state.user.role !== "patient") {
      hideModal("prescriptionModal");
      await openRole("patient");
      toast("Retsept yuborish uchun bemor hisobiga kiring.", "warn");
      return;
    }
    var file = el("prescriptionFile").files[0];
    var status = el("prescriptionStatus");
    if (!file || !el("prescriptionConsent").checked) {
      status.className = "status error";
      status.textContent = "Fayl va rozilik belgisini to‘ldiring.";
      return;
    }
    var form = new FormData();
    form.append("file", file);
    form.append("consent", "true");
    var branchText = el("prescriptionBranch").value || "Toshkent";
    form.append("branch", branchText.split(" ")[0].toLowerCase());
    try {
      status.className = "status";
      status.textContent = "Retsept xavfsiz serverga yuklanmoqda…";
      var data = await api("/api/prescriptions", {method:"POST", body:form});
      status.className = "status";
      status.innerHTML = '<b>Retsept qabul qilindi.</b><br>Kod: '+esc(data.prescription.code)+' · Farmatsevt tekshiradi.';
      toast("Retsept serverga yuborildi.", "success");
    } catch (error) {
      status.className = "status error";
      status.textContent = error.message;
    }
  }

  async function openSecurePassport() {
    if (!state.user || state.user.role !== "patient") { await openRole("patient"); return; }
    try {
      var data = await api("/api/health-passport");
      fillPassport(data.passport || {});
      showModal("gpPassportModal");
    } catch (error) { toast(error.message, "error"); }
  }

  function fillPassport(passport) {
    var map = {gpPassName:"name",gpPassBirth:"birth",gpPassBlood:"blood",gpPassPhone:"phone",gpPassAllergy:"allergy",gpPassMedicines:"medicines",profileName:"name",profileAge:"age",profileAllergies:"allergy",profileMedicines:"medicines",profileEmergencyName:"emergency_name",profileEmergencyPhone:"emergency_phone"};
    Object.keys(map).forEach(function (id) { if (el(id)) el(id).value = passport[map[id]] || ""; });
    if (el("gpPassConsent")) el("gpPassConsent").checked = !!Object.keys(passport).length;
    updatePassportCard(passport);
  }

  function updatePassportCard(passport) {
    if (el("gpProfileName")) el("gpProfileName").textContent = passport.name || (state.user ? state.user.name : "Mehmon profili");
    var fields = [passport.name,passport.birth,passport.blood,passport.phone,passport.allergy,passport.medicines];
    var percent = Math.max(18, Math.round(fields.filter(Boolean).length/fields.length*100));
    if (el("gpProfilePercent")) el("gpProfilePercent").textContent = percent + "%";
    if (el("gpProfileRing")) el("gpProfileRing").style.setProperty("--progress", percent + "%");
    if (el("gpProfileText")) el("gpProfileText").textContent = Object.keys(passport).length ? "Ma’lumotlar shifrlangan server bazasida saqlangan." : "Allergiya, doimiy dori va favqulodda kontaktni xavfsiz saqlang.";
  }

  async function savePassportFromGlobal() {
    var status = el("gpPassportStatus");
    if (!state.user || state.user.role !== "patient") { hideModal("gpPassportModal"); await openRole("patient"); return; }
    try {
      var data = await api("/api/health-passport", {method:"PUT", body:{name:el("gpPassName").value, birth:el("gpPassBirth").value, blood:el("gpPassBlood").value, phone:el("gpPassPhone").value, allergy:el("gpPassAllergy").value, medicines:el("gpPassMedicines").value, consent:el("gpPassConsent").checked}});
      status.className = "status gp-modal-status";
      status.textContent = "Sog‘liq pasporti shifrlangan server bazasiga saqlandi.";
      updatePassportCard(data.passport || {});
      await syncPatientData(state.orders);
      toast("Sog‘liq pasporti saqlandi.", "success");
    } catch (error) { status.className = "status error gp-modal-status"; status.textContent = error.message; }
  }

  async function savePassportFromLegacy() {
    if (!state.user || state.user.role !== "patient") { hideModal("healthProfileModal"); await openRole("patient"); return; }
    try {
      var data = await api("/api/health-passport", {method:"PUT", body:{name:el("profileName").value, age:el("profileAge").value, allergy:el("profileAllergies").value, medicines:el("profileMedicines").value, emergency_name:el("profileEmergencyName").value, emergency_phone:el("profileEmergencyPhone").value, consent:true}});
      updatePassportCard(data.passport || {});
      await syncPatientData(state.orders);
      hideModal("healthProfileModal");
      toast("Sog‘liq profili serverga saqlandi.", "success");
    } catch (error) { toast(error.message, "error"); }
  }

  async function clearPassport() {
    if (!state.user) return;
    if (!confirm("Sog‘liq pasportini serverdan o‘chirasizmi?")) return;
    await api("/api/health-passport", {method:"DELETE", body:{}});
    fillPassport({});
    await syncPatientData(state.orders);
    toast("Sog‘liq pasporti o‘chirildi.", "success");
  }

  async function openLegacyHealthProfile() {
    if (!state.user || state.user.role !== "patient") {
      await openRole("patient");
      toast("Sog‘liq profilini ko‘rish uchun bemor hisobiga kiring.", "warn");
      return;
    }
    try {
      var result = await api("/api/health-passport");
      var profile = legacyHealthProfile(result.passport || {});
      if (el("profileName")) el("profileName").value = profile.name;
      if (el("profileAge")) el("profileAge").value = profile.age;
      if (el("profileAllergies")) el("profileAllergies").value = profile.allergies;
      if (el("profileMedicines")) el("profileMedicines").value = profile.medicines;
      if (el("profileEmergencyName")) el("profileEmergencyName").value = profile.emergencyName;
      if (el("profileEmergencyPhone")) el("profileEmergencyPhone").value = profile.emergencyPhone;
      showModal("healthProfileModal");
    } catch (error) { toast(error.message, "error"); }
  }

  function wireStaticButtons() {
    document.querySelectorAll("[data-platform-role]").forEach(function (button) {
      button.onclick = function () { openRole(button.getAttribute("data-platform-role")); };
    });
    document.querySelectorAll("[data-platform-tab]").forEach(function (button) {
      button.onclick = function () {
        state.activeRole = button.getAttribute("data-platform-tab");
        updateRoleTabs();
        renderActiveRole();
      };
    });
    if (el("platformClose")) el("platformClose").onclick = function () { hideModal("platformModal"); };
    if (el("platformModal")) el("platformModal").onclick = function (event) { if (event.target === el("platformModal")) hideModal("platformModal"); };
    if (el("trackerClose")) el("trackerClose").onclick = closeTracking;
    if (el("courierTrackModal")) el("courierTrackModal").onclick = function (event) { if (event.target === el("courierTrackModal")) closeTracking(); };
    if (el("trackerMessage")) el("trackerMessage").onclick = function () { toast("Xabar moduli uchun SMS/chat provayderi ulanadi.", "warn"); };
    if (el("placeOrderButton")) el("placeOrderButton").onclick = securePlaceOrder;
    if (el("checkoutUseLocation")) el("checkoutUseLocation").onclick = getCheckoutLocation;
    if (el("sendPrescription")) el("sendPrescription").onclick = securePrescription;
    if (el("gpOpenPassport")) el("gpOpenPassport").onclick = openSecurePassport;
    if (el("gpSavePassport")) el("gpSavePassport").onclick = savePassportFromGlobal;
    if (el("gpClearPassport")) el("gpClearPassport").onclick = clearPassport;
    if (el("saveHealthProfile")) el("saveHealthProfile").onclick = savePassportFromLegacy;
    if (el("openHealthProfile")) el("openHealthProfile").onclick = openLegacyHealthProfile;
    if (el("refreshDashboard")) el("refreshDashboard").onclick = function () { openRole("manager"); };
    if (el("openCabinetTop")) el("openCabinetTop").onclick = function () { openRole(state.user ? (state.user.role === "admin" ? "manager" : state.user.role) : "patient"); };
    if (el("cabinetButton")) el("cabinetButton").onclick = function () { openRole(state.user ? (state.user.role === "admin" ? "manager" : state.user.role) : "patient"); };
    if (el("checkoutButton")) {
      var originalCheckout = el("checkoutButton").onclick;
      el("checkoutButton").onclick = function () {
        if (typeof originalCheckout === "function") originalCheckout.call(this);
        if (state.user && el("checkoutPhone")) el("checkoutPhone").value = state.user.phone || "";
        if (state.user && el("checkoutAddress") && !el("checkoutAddress").value) el("checkoutAddress").value = state.user.address || "";
      };
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    clearSensitiveDemoStorage();
    try { await refreshMe(); } catch (error) { console.warn(error); }
    wireStaticButtons();
    updateRoleTabs();
    await syncCatalog();
    if (state.user && state.user.role === "patient") {
      try {
        var data = await api("/api/health-passport");
        fillPassport(data.passport || {});
        await syncPatientData();
      } catch (e) { console.warn(e); }
    } else {
      hydrateSmartData({}, {reminders: [], family_members: [], reservations: []}, []);
    }
    window.MarjonSecure = {openRole:openRole, refreshMe:refreshMe, openTracking:openTracking, state:state};
  });
})();
