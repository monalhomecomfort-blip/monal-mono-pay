import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { google } from "googleapis";
import mysql from "mysql2/promise";
import bcrypt from "bcrypt";

const app = express();

/* ===================== MYSQL ===================== */

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5
});

/* ===================== GOOGLE SHEETS ===================== */

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({
    version: "v4",
    auth,
});

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || "certificates";
const ORDERS_SHEET_NAME = "ORDERS_LOG";

async function appendOrderToOrdersLog({
    orderId,
    source,
    totalAmount,
    paidAmount,
    dueAmount,
    paymentType,
    buyerName,
    buyerPhone,
    delivery,
    itemsText,
    orderNote,
}) {
    const now = new Date()
        .toLocaleString("sv-SE", { timeZone: "Europe/Kyiv" })
        .replace(" ", "T");

    await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${ORDERS_SHEET_NAME}!A:N`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
            values: [
                [
                    orderId,     // A: ID замовлення
                    source,      // B: Джерело
                    now,         // C: Дата оплати
                    totalAmount, // D: Сума замовлення
                    paidAmount,  // E: Сплачено
                    dueAmount,   // F: До оплати
                    paymentType, // G: Тип оплати
                    buyerName,   // H: Імʼя клієнта
                    buyerPhone,  // I: Телефон
                    delivery,    // J: Доставка
                    itemsText,   // K: Склад замовлення
                    false,       // L: Виконано
                    "",          // M: Дата виконання
                    orderNote || "",        // N: Примітки
                ],
            ],
        },
    });    
}

/* ===================== ПОГАШЕННЯ СЕРТИФІКАТУ ===================== */
/* ❗ НЕ ВИКЛИКАЄТЬСЯ ТУТ — БУДЕ ВИКОРИСТАНО ПРИ РЕАЛЬНОМУ ПОГАШЕННІ */

async function markCertificateAsUsed(certCode) {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A:H`,
    });

    const rows = res.data.values || [];
    if (!rows.length) return;

    // шукаємо рядок по коду сертифіката
    const rowIndex = rows.findIndex(
        (row, idx) => idx > 0 && row[0] === certCode
    );

    if (rowIndex === -1) return;

    const now = new Date().toISOString();

    // ОНОВЛЮЄМО ТІЛЬКИ:
    // E — Дата використання
    // G — Статус
    await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!E${rowIndex + 1}:G${rowIndex + 1}`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
            values: [
                [
                    now,               // E — Дата використання
                    rows[rowIndex][5], // F — Order ID покупки (залишаємо як є)
                    "used",            // G — Статус
                ],
            ],
        },
    });
    await db.query(
        `UPDATE certificates
         SET used_at = ?, status = 'used'
         WHERE certificate_code = ?`,
        [new Date(now), certCode]
    );
}
/* ===================== CONFIG ===================== */

app.use(cors({
    origin: [
        "https://test.monal.com.ua",
        "https://monal.com.ua"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: "10mb" }));

// orderId → { text, certificates }
const ORDERS = new Map();

function getEffectiveDiscount(customerStatus, totalSpent) {
    const status = String(customerStatus || "general").toLowerCase();

    if (status === "friends") return 15;
    if (status === "partners") return 20;

    const spent = Number(totalSpent || 0);

    if (spent >= 12000) return 10;
    if (spent >= 9000) return 7;
    if (spent >= 6000) return 5;
    if (spent >= 3000) return 3;

    return 0;
}

async function markWelcomeDiscountUsed(userId) {
    const uid = Number(userId || 0);

    if (uid <= 0) return;

    try {
        await db.query(
            `UPDATE customers
             SET welcome_discount_used = 1
             WHERE id = ?
               AND LOWER(COALESCE(customer_status, 'general')) = 'general'
               AND welcome_discount_used = 0`,
            [uid]
        );
    } catch (err) {
        console.error("WELCOME DISCOUNT UPDATE ERROR:", err);
    }
}

/* ===================== REGISTER USER ===================== */

app.post("/api/register", async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ error: "missing fields" });
        }
        const [existing] = await db.query(
            "SELECT id FROM customers WHERE email = ?",
            [email]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: "email exists" });
        }
        const hash = await bcrypt.hash(password, 10);
        await db.query(
            "INSERT INTO customers (name, email, password_hash, total_spent, discount, customer_status) VALUES (?, ?, ?, 0, 0, ?)",
            [name, email, hash, "general"]
        );
        res.json({ ok: true });
    } catch (e) {
        console.error("REGISTER ERROR:", e);
        res.status(500).json({ error: "server error" });
    }
});

/* ===================== LOGIN USER ===================== */
app.post("/api/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: "missing fields" });
        }
        const [rows] = await db.query(
            "SELECT * FROM customers WHERE email = ?",
            [email]
        );
        if (rows.length === 0) {
            return res.status(401).json({ error: "invalid login" });
        }
        const user = rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: "invalid login" });
        }
        res.json({
            ok: true,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                birthday: user.birthday,
                gender: user.gender,
                address: user.address,
                avatar_data: user.avatar_data,
                has_pet: user.has_pet,
                has_car: user.has_car,
                travels_often: user.travels_often,
                customer_status: user.customer_status,
                welcome_discount_used: Number(user.welcome_discount_used) === 1,
                discount: getEffectiveDiscount(user.customer_status, user.total_spent),
                total_spent: user.total_spent
            }
        });
    } catch (err) {
        console.error("LOGIN ERROR:", err);
        res.status(500).json({ error: "server error" });
    }
});

/* ===================== GET USER DATA ===================== */
app.get("/api/user/:id", async (req, res) => {
    try {
        const userId = Number(req.params.id);
        if (!userId) {
            return res.status(400).json({ error: "invalid user id" });
        }
        const [rows] = await db.query(
            "SELECT id, name, email, phone, birthday, gender, address, avatar_data, has_pet, has_car, travels_often, customer_status, welcome_discount_used, discount, total_spent FROM customers WHERE id = ?",
            [userId]
        );
        if (!rows.length) {
            return res.status(404).json({ error: "user not found" });
        }
        res.json({
            ...rows[0],
            welcome_discount_used: Number(rows[0].welcome_discount_used) === 1,
            discount: getEffectiveDiscount(rows[0].customer_status, rows[0].total_spent)
        });      
    } catch (err) {
        console.error("GET USER ERROR:", err);
        res.status(500).json({ error: "server error" });
    }
});

/* ===================== UPDATE PROFILE ===================== */
app.post("/api/update-profile", async (req, res) => {
    const {
        userId,
        birthday,
        phone,
        gender,
        address,
        has_pet,
        has_car,
        travels_often
    } = req.body;

    if (!userId) {
        return res.json({ ok: false });
    }
    try {
        const fields = [];
        const values = [];
        if (birthday !== undefined) {
            fields.push("birthday = ?");
            values.push(birthday || null);
        }
        if (phone !== undefined) {
            fields.push("phone = ?");
            values.push(phone || null);
        }
        if (gender !== undefined) {
            fields.push("gender = ?");
            values.push(gender || null);
        }
        if (address !== undefined) {
            fields.push("address = ?");
            values.push(address || null);
        }
        if (has_pet !== undefined) {
            fields.push("has_pet = ?");
            values.push(has_pet);
        }
        if (has_car !== undefined) {
            fields.push("has_car = ?");
            values.push(has_car);
        }
        if (travels_often !== undefined) {
            fields.push("travels_often = ?");
            values.push(travels_often);
        }
        if (!fields.length) {
            return res.json({ ok: false });
        }
        values.push(userId);
        await db.execute(
            `UPDATE customers SET ${fields.join(", ")} WHERE id = ?`,
            values
        );
        return res.json({ ok: true });
    } catch (err) {
        console.error("UPDATE PROFILE ERROR:", err);
        return res.json({ ok: false });
    }
});

/* ===================== UPDATE AVATAR ===================== */
app.post("/api/update-avatar", async (req, res) => {
    try {
        const { userId, avatar_data } = req.body;
        if (!userId) {
            return res.status(400).json({ ok: false, error: "userId required" });
        }
        if (!avatar_data) {
            return res.status(400).json({ ok: false, error: "avatar_data required" });
        }
        if (!avatar_data.startsWith("data:image/jpeg;base64,")) {
            return res.status(400).json({
                ok: false,
                error: "Only compressed jpeg base64 is allowed"
            });
        }
        await db.execute(
            "UPDATE customers SET avatar_data = ? WHERE id = ?",
            [avatar_data, userId]
        );
        return res.json({ ok: true });
    } catch (err) {
        console.error("UPDATE AVATAR ERROR:", err);
        return res.status(500).json({ ok: false, error: "server error" });
    }
});

/* ===================== SAVE REVIEW ===================== */
app.post("/api/reviews", async (req, res) => {
    try {
        const { userId, review_type, category_slug, review_text } = req.body;
        if (!userId || !review_type || !review_text) {
            return res.status(400).json({ ok: false, error: "missing fields" });
        }
        if (!["brand", "product"].includes(review_type)) {
            return res.status(400).json({ ok: false, error: "invalid review type" });
        }
        if (review_type === "product" && !category_slug) {
            return res.status(400).json({ ok: false, error: "missing category" });
        }
        const cleanText = String(review_text).trim();
        if (cleanText.length < 5) {
            return res.status(400).json({ ok: false, error: "too short review" });
        }
        await db.query(
            `INSERT INTO reviews (user_id, review_type, category_slug, review_text, status)
             VALUES (?, ?, ?, ?, 'pending')`,
            [
                userId,
                review_type,
                review_type === "product" ? category_slug : null,
                cleanText
            ]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error("SAVE REVIEW ERROR:", err);
        res.status(500).json({ ok: false, error: "server error" });
    }
});

/* ===================== GET APPROVED REVIEWS ===================== */

app.get("/api/reviews/approved", async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT
                r.id,
                r.review_type,
                r.category_slug,
                r.review_text,
                r.created_at,
                c.name
             FROM reviews r
             JOIN customers c ON r.user_id = c.id
             WHERE r.status = 'approved'
             ORDER BY r.created_at DESC`
        );
        res.json({
            ok: true,
            reviews: rows
        });
    } catch (err) {
        console.error("GET APPROVED REVIEWS ERROR:", err);
        res.status(500).json({ ok: false, error: "server error" });
    }
});

/* ===================== SAVE ASSORTMENT WISH ===================== */
app.post("/api/assortment-wishes", async (req, res) => {
    try {
        const { userId, wish_text } = req.body;
        if (!userId || !wish_text) {
            return res.status(400).json({ ok: false, error: "missing fields" });
        }
        const cleanText = String(wish_text).trim();
        if (cleanText.length < 5) {
            return res.status(400).json({ ok: false, error: "too short wish" });
        }
        await db.query(
            `INSERT INTO assortment_wishes (user_id, wish_text, status)
             VALUES (?, ?, 'new')`,
            [userId, cleanText]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error("SAVE ASSORTMENT WISH ERROR:", err);
        res.status(500).json({ ok: false, error: "server error" });
    }
});

/* ===================== GET USER ORDERS ===================== */
app.get("/api/orders/:userId", async (req, res) => {
    try {
        const userId = req.params.userId;
        if (!userId) {
            return res.status(400).json({ ok: false, error: "missing user id" });
        }
        const [rows] = await db.query(
            `SELECT
                id,
                order_id,
                buyer_name,
                buyer_phone,
                delivery,
                items_text,
                total_amount,
                paid_amount,
                due_amount,
                payment_type,
                created_at
             FROM orders
             WHERE user_id = ?
             ORDER BY created_at DESC`,
            [userId]
        );
        res.json({
            ok: true,
            orders: rows
        });
    } catch (err) {
        console.error("GET USER ORDERS ERROR:", err);
        res.status(500).json({ ok: false, error: "server error" });
    }
});

/* ===================== GET PERSONAL CERTIFICATES ===================== */
app.get("/api/certificates/:userId", async (req, res) => {
    try {
        const userId = Number(req.params.userId);

        if (!userId) {
            return res.status(400).json({ ok: false, error: "invalid user id" });
        }

        const [rows] = await db.query(
            `SELECT
                id,
                certificate_code,
                nominal,
                created_at,
                expires_at,
                used_at,
                status,
                certificate_type,
                purchase_order_id
             FROM certificates
             WHERE owner_user_id = ?
             ORDER BY created_at DESC`,
            [userId]
        );

        const activeCertificates = rows.filter(row => row.status === "active");
        const usedCertificates = rows.filter(row => row.status === "used");

        res.json({
            ok: true,
            activeCertificates,
            usedCertificates
        });
    } catch (err) {
        console.error("GET USER CERTIFICATES ERROR:", err);
        res.status(500).json({ ok: false, error: "server error" });
    }
});

/* ===================== GET ACTIVE PUBLIC PROMO CAMPAIGNS ===================== */
app.get("/api/public-promo-campaigns", async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT
                c.id,
                c.title,
                c.promo_type,
                c.discount_percent,
                c.focus_product_id,
                c.starts_at,
                c.ends_at,
                c.is_active,
                c.audience,
                c.exclude_certificates,
                c.exclude_from_personal_discount,
                c.combinable,
                c.target_apply_limit,
                c.target_selection,
                c.priority,

                p.product_key,
                p.product_name,
                p.product_label,
                p.category_slug,
                p.price,
                p.display_name
             FROM promo_campaigns c
             LEFT JOIN products_catalog p
                ON p.id = c.focus_product_id
             WHERE c.is_active = 1
               AND c.audience = 'public'
               AND c.starts_at <= NOW()
               AND c.ends_at >= NOW()
             ORDER BY c.priority ASC, c.id DESC`
        );

        res.json({
            ok: true,
            campaigns: rows
        });
    } catch (err) {
        console.error("GET PUBLIC PROMO CAMPAIGNS ERROR:", err);
        res.status(500).json({
            ok: false,
            campaigns: []
        });
    }
});
/* ===================== GET ACTIVE PERSONAL OFFERS ===================== */
app.get("/api/personal-offers", async (req, res) => {
    try {
        const userId = Number(req.query.userId);

        if (!userId) {
            return res.status(400).json({ ok: false, error: "invalid user id" });
        }

        const [users] = await db.query(
            "SELECT customer_status FROM customers WHERE id = ?",
            [userId]
        );

        if (!users.length) {
            return res.status(404).json({ ok: false, error: "user not found" });
        }

        const customerStatus = users[0].customer_status || "general";

        const [rows] = await db.query(
            `SELECT
                id,
                title,
                offer_text,
                offer_type,
                promo_code,
                discount_percent,
                discount_amount,
                min_order_amount,
                required_category_slug,
                required_discount_level,
                required_customer_status,
                starts_at,
                ends_at
             FROM personal_offers
             WHERE is_active = 1
               AND (starts_at IS NULL OR starts_at <= NOW())
               AND (ends_at IS NULL OR ends_at >= NOW())
               AND (required_customer_status = ? OR required_customer_status = 'all')
             ORDER BY created_at DESC`,
            [customerStatus]
        );

        res.json({
            ok: true,
            offers: rows
        });
    } catch (err) {
        console.error("GET PERSONAL OFFERS ERROR:", err);
        res.status(500).json({ ok: false, error: "server error" });
    }
});

/* ===================== PARTNERSHIP REQUEST ===================== */
app.post("/api/partnership-request", async (req, res) => {
    try {
        const {
            name,
            email,
            phone,
            message
        } = req.body || {};

        const cleanName = String(name || "").trim();
        const cleanEmail = String(email || "").trim();
        const cleanPhone = String(phone || "").trim();
        const cleanMessage = String(message || "").trim();

        if (!cleanName || !cleanEmail || !cleanPhone || !cleanMessage) {
            return res.status(400).json({
                ok: false,
                error: "missing fields"
            });
        }

        const tgText =
            "🤝 *НОВА ЗАЯВКА НА ПАРТНЕРСТВО*\n\n" +
            `👤 *Контактна особа:* ${cleanName}\n` +
            `📧 *E-mail:* ${cleanEmail}\n` +
            `📞 *Телефон:* ${cleanPhone}\n\n` +
            `📝 *Текст пропозиції:*\n${cleanMessage}`;

        const tgRes = await fetch(
            `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    chat_id: process.env.CHAT_ID,
                    text: tgText,
                    parse_mode: "Markdown"
                })
            }
        );

        const tgData = await tgRes.json();

        if (!tgRes.ok || !tgData.ok) {
            console.error("PARTNERSHIP TG ERROR:", tgData);
            return res.status(500).json({
                ok: false,
                error: "telegram send failed"
            });
        }

        return res.json({ ok: true });
    } catch (err) {
        console.error("PARTNERSHIP REQUEST ERROR:", err);
        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});




/* ===================== HEALTH ===================== */
app.get("/", (req, res) => {
    res.send("Mono webhook is alive");
});

/* ===================== REGISTER ORDER ===================== */
app.post("/register-order", (req, res) => {
    const {
        orderId,
        text,
        userId,
        userEmail,
        customerStatus,
        welcomeDiscountUsed,
        certificates,
        usedCertificates,
        certificateType,
        buyerName,
        buyerPhone,
        delivery,
        itemsText,
        totalAmount,
        paidAmount,
        dueAmount,
        paymentLabel,
        orderNote,
    } = req.body;

    console.log("REGISTER ORDER CERTIFICATES:", certificates);

    if (!orderId || !text) {
        return res.status(400).json({
            error: "orderId або text відсутні",
        });
    }

    console.log("ORDER_REGISTERED", JSON.stringify({
        orderId,
        userId,
        userEmail,
        buyerName,
        buyerPhone,
        totalAmount,
        paidAmount,
        dueAmount,
        paymentLabel,
        itemsText,
        orderNote
    }));

    ORDERS.set(orderId, {
        // для Telegram
        text,

        // 🔹 ДЖЕРЕЛО ЗАМОВЛЕННЯ
        source: req.body.source || "site",
        userId: req.body.userId || null,
        userEmail: req.body.userEmail || null,
        customerStatus: customerStatus || null,
        welcomeDiscountUsed: Boolean(welcomeDiscountUsed),
        
        // для сертифікатів
        certificates: Array.isArray(certificates) ? certificates : null,
        usedCertificates: Array.isArray(usedCertificates) ? usedCertificates : [],
        certificateType: certificateType || "електронний",

        // 👇 ДАНІ ДЛЯ ORDERS_LOG
        buyerName: buyerName || "",
        buyerPhone: buyerPhone || "",
        delivery: delivery || "",
        itemsText: itemsText || "",
        totalAmount: totalAmount || "",
        paidAmount: paidAmount || "",
        dueAmount: dueAmount || "",
        paymentLabel: paymentLabel || "",
        orderNote: orderNote || "",
        personalDiscount: req.body.personalDiscount || 0,
        promoDiscount: req.body.promoDiscount || 0,
        certificateAmount: req.body.certificateAmount || 0,
    });

    res.json({ ok: true });
});
/* ===================== CREATE PAYMENT ===================== */

app.post("/create-payment", async (req, res) => {
    const { amount, orderId } = req.body;

    // ✅ ОБОВʼЯЗКОВІ ПЕРЕВІРКИ
    if (!amount || isNaN(amount)) {
        return res.status(400).json({ error: "Invalid amount" });
    }

    if (!orderId) {
        return res.status(400).json({ error: "Missing orderId" });
    }

    const response = await fetch(
        "https://api.monobank.ua/api/merchant/invoice/create",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Token": process.env.MONO_TOKEN,
            },
            body: JSON.stringify({
                amount: Math.round(amount * 100),
                ccy: 980,
                merchantPaymInfo: {
                    reference: orderId,
                    destination: `Замовлення №${orderId}`,
                },
                redirectUrl: "https://monal.com.ua/payment-success.html",
                webhookUrl:
                    "https://monal-mono-pay-production.up.railway.app/mono-webhook",
            }),
        }
    );

    const data = await response.json();

    if (!response.ok || !data.pageUrl) {
        console.error("MONO ERROR:", data);
        return res.status(400).json(data);
    }

    res.json({ pageUrl: data.pageUrl });
});


/* ===================== CHECK CERTIFICATE ===================== */

app.post("/check-certificate", async (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ error: "code missing" });
    }

    const result = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A:H`,
    });

    const rows = result.data.values || [];
    const row = rows.find((r) => r[0] === code);

    if (!row) {
        return res.json({ valid: false, reason: "not_found" });
    }

    const status = row[6];     // G — status
    const expiresAt = row[3];  // D — expiresAt (ISO)
    const now = new Date();

    if (status !== "active") {
        return res.json({ valid: false, reason: "used" });
    }

    if (!expiresAt || new Date(expiresAt) < now) {
        return res.json({ valid: false, reason: "expired" });
    }

    res.json({
        valid: true,
        nominal: Number(row[1]),
    });
});
/* ===================== MONO WEBHOOK ===================== */

app.post("/mono-webhook", async (req, res) => {
    console.log(
        "💳 MONO WEBHOOK DATA:",
        JSON.stringify(req.body, null, 2)
    );

    const data = req.body;

    if (data.status !== "success") {
        console.log(`⏳ MONO STATUS: ${data.status}`);
        return res.sendStatus(200);
    }

    const orderId =
        data.reference || data.merchantPaymInfo?.reference;

    const order = ORDERS.get(orderId);
    if (!order) return res.sendStatus(200);

    // ===============================
    // 🔔 СПОВІЩЕННЯ АДМІНУ (ЄДИНЕ)
    // ===============================

    let finalText =
        "🔔 *НОВЕ ЗАМОВЛЕННЯ*\n\n" +
        `👤 ${order.buyerName || "—"}\n` +
        `📞 ${order.buyerPhone || "—"}\n` +
        `📦 ${order.delivery || "—"}\n` +
        `💳 ${order.paymentLabel || "—"}\n` +
        (order.orderNote ? `📝 *Примітка:* ${order.orderNote}\n` : "");

    // 🎁 Тип сертифікату (якщо є)
    if (order.certificates && order.certificates.length > 0) {
        finalText +=
            `🎁 *Тип сертифікату:* ${
                order.certificateType === "фізичний"
                    ? "Фізичний (потрібен друк і відправка)"
                    : "Електронний"
            }\n`;
    }

    // ===============================
    // 💰 РОЗРАХУНОК СУМ
    // ===============================

    const totalAmount = Number(order.totalAmount) || 0;
    const paidByMono = Number(order.paidAmount) || 0;
    const dueAmount = Number(order.dueAmount) || 0;

    const personalDiscount = Number(order.personalDiscount) || 0;
    const promoDiscount = Number(order.promoDiscount) || 0;
    const certAmount = Number(order.certificateAmount) || 0;

    // 🎟 сплачено сертифікатом
    const paidByCertificate = Math.max(
        totalAmount - paidByMono - dueAmount,
        0
    );

    // ===============================
    // 🛒 ТОВАРИ + СУМИ
    // ===============================

    finalText +=
        `\n🛒 *Товари:*\n${order.itemsText || "—"}\n\n` +
        `💰 *Сума замовлення:* ${totalAmount} грн\n` +
        (personalDiscount > 0
            ? `👤 *${
                order.userId &&
                String(order.customerStatus || "general").toLowerCase() === "general" &&
                !Boolean(order.welcomeDiscountUsed)
                    ? "Welcome-знижка 10%"
                    : "Персональна знижка"
              }:* ${personalDiscount} грн\n`
            : "") +
        (promoDiscount > 0
            ? `🏷 *Промокод:* ${promoDiscount} грн\n`
            : "") +
        (certAmount > 0
            ? `🎟 *Сертифікатом:* ${certAmount} грн\n`
            : "") +
        `💳 *Через mono:* ${paidByMono} грн\n` +
        `📦 *До оплати:* ${dueAmount} грн\n\n` +
        `🔗 ref: ${orderId}`;

    // ⬇️ далі у тебе йде send / логування (як було)

// ===============================
// 🎁 ГЕНЕРАЦІЯ СЕРТИФІКАТІВ
// ===============================

if (
    !order._certificatesGenerated &&
    Array.isArray(order.certificates) &&
    order.certificates.length > 0
) {
    order._certificatesGenerated = true;

    const createdAt = new Date();

    for (const cert of order.certificates) {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

        const part1 = Array.from(
            { length: 4 },
            () => chars[Math.floor(Math.random() * chars.length)]
        ).join("");

        const part2 = Array.from(
            { length: 4 },
            () => chars[Math.floor(Math.random() * chars.length)]
        ).join("");

        const certCode = `${part1}-${part2}`;

        const expiresAt = new Date(createdAt);
        expiresAt.setMonth(createdAt.getMonth() + 3);

        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: `${SHEET_NAME}!A:H`,
            valueInputOption: "USER_ENTERED",
            requestBody: {
                values: [
                    [
                        certCode,
                        cert.nominal,
                        createdAt.toISOString(),
                        expiresAt.toISOString(),
                        "",
                        orderId,
                        "active",
                        order.certificateType || "електронний",
                    ],
                ],
            },
        });
        await db.query(
            `INSERT INTO certificates (
                certificate_code,
                owner_user_id,
                purchase_order_id,
                nominal,
                created_at,
                expires_at,
                used_at,
                status,
                certificate_type
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                certCode,
                order.userId || null,
                orderId,
                Number(cert.nominal || 0),
                createdAt,
                expiresAt,
                null,
                "active",
                order.certificateType || "електронний"
            ]
        );
    }
}

// 🔥 ПОЗНАЧАЄМО СЕРТИФІКАТ ВИКОРИСТАНИМ ПРИ СКЛАДНІЙ ОПЛАТІ

if (order.usedCertificates && order.usedCertificates.length > 0) {
    for (const code of order.usedCertificates) {
        await markCertificateAsUsed(code);
    }
}
// ===============================
// 🧾 ЗАПИС У ORDERS_LOG
// ===============================

await appendOrderToOrdersLog({
    orderId: orderId,
    source: order.source || "site",
    totalAmount: order.totalAmount || "",
    paidAmount: order.paidAmount || "",
    dueAmount: order.dueAmount || "",
    paymentType: order.paymentLabel || "",
    buyerName: order.buyerName || "",
    buyerPhone: order.buyerPhone || "",
    delivery: order.delivery || "",
    itemsText: order.itemsText || "",
    orderNote: order.orderNote || "",
});

// ===============================
// 💾 ЗАПИС У MYSQL (ДУБЛЬ ЗАМОВЛЕННЯ)
// ===============================

try {
    await db.query(
        `INSERT INTO orders (
            order_id,
            user_id,
            user_email,
            source,
            buyer_name,
            buyer_phone,
            delivery,
            items_text,
            total_amount,
            paid_amount,
            due_amount,
            payment_type,
            order_note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            orderId,
            order.userId || null,
            order.userEmail || null,
            order.source || "site",
            order.buyerName || "",
            order.buyerPhone || "",
            order.delivery || "",
            order.itemsText || "",
            Number(order.totalAmount || 0),
            Number(order.paidAmount || 0),
            Number(order.dueAmount || 0),
            order.paymentLabel || "",
            order.orderNote || ""
        ]
    );
} catch (err) {
    console.error("MYSQL ORDER INSERT ERROR:", err);
}

// ===============================
// 👑 ОНОВЛЕННЯ НАКОПИЧЕННЯ КЛІЄНТА
// ===============================

const uid = Number(order.userId || 0);

if (uid > 0) {

    const loyaltyAmount =
        Number(order.paidAmount || 0) +
        Number(order.dueAmount || 0);

    try {

        // оновлюємо суму покупок
        await db.query(
            "UPDATE customers SET total_spent = total_spent + ? WHERE id = ?",
            [
                loyaltyAmount,
                uid
            ]
        );

        // беремо нову суму
        const [rows] = await db.query(
            "SELECT total_spent, customer_status FROM customers WHERE id = ?",
            [uid]
        );

        if (rows.length) {

            const newDiscount = getEffectiveDiscount(
                rows[0].customer_status,
                rows[0].total_spent
            );

            await db.query(
                "UPDATE customers SET discount = ? WHERE id = ?",
                [newDiscount, uid]
            );

        }

    } catch (err) {
        
        console.error("MYSQL LOYALTY UPDATE ERROR:", err);

    }
    
    await markWelcomeDiscountUsed(uid);

}
// ===============================
// 📩 ВІДПРАВКА АДМІНУ
// ===============================

await fetch(
    `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,
    {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            chat_id: process.env.CHAT_ID,
            text: finalText,
            parse_mode: "Markdown",
        }),
    }
);

// 📩 СПОВІЩЕННЯ ПОКУПЦЮ В TELEGRAM-БОТІ

if (order.userId) {
    await fetch(
        `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                chat_id: order.userId,
                text:
                    "✅ Оплату отримано!\n\n" +
                    "Дякуємо за замовлення 💛",
                reply_markup: {
                    keyboard: [[{ text: "🛒 Почати замовлення" }]],
                    resize_keyboard: true,
                },
            }),
        }
    );

    await fetch(
        "https://monal-mono-pay-production.up.railway.app/bot-finalize",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                userId: order.userId,
            }),
        }
    );
}

ORDERS.delete(orderId);
res.sendStatus(200);
});

/* ===================== FREE ORDER (CERTIFICATE 100%) ===================== */

app.post("/send-free-order", async (req, res) => {
    const { orderId, usedCertificates } = req.body;

    if (!orderId) return res.sendStatus(400);

    const order = ORDERS.get(orderId);
    if (!order) return res.sendStatus(404);

    const uid = Number(order.userId || 0);

    if (uid > 0) {
        await markWelcomeDiscountUsed(uid);
    }

    // ✅ позначаємо використаний сертифікат (якщо був)
    const certsToUse =
        Array.isArray(usedCertificates) && usedCertificates.length
            ? usedCertificates
            : order.usedCertificates || [];

    if (certsToUse.length) {
        for (const code of certsToUse) {
            await markCertificateAsUsed(code);
        }
    }

    const finalText =
        order.text +
        (order.orderNote ? `\n📝 *Примітка:* ${order.orderNote}\n` : "") +
        "\n💳 *Оплата:* Сертифікат (100%)\n";

    // 🧾 ЗАПИС У ORDERS_LOG — ОПЛАТА СЕРТИФІКАТОМ 100%
    await appendOrderToOrdersLog({
        orderId: orderId,
        source: "site",
        totalAmount: order.totalAmount || "",
        paidAmount: order.totalAmount || "",
        dueAmount: 0,
        paymentType: "Оплачено сертифікатом 100%",
        buyerName: order.buyerName || "",
        buyerPhone: order.buyerPhone || "",
        delivery: order.delivery || "",
        itemsText: order.itemsText || "",
        orderNote: order.orderNote || "",
    });

    await fetch(
        `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                chat_id: process.env.CHAT_ID,
                text: finalText,
                parse_mode: "Markdown",
            }),
        }
    );

    ORDERS.delete(orderId);
    res.json({ ok: true });
});
/* ===================== BOT → ORDERS_LOG ===================== */

app.post("/log-bot-order", async (req, res) => {
    try {
        const {
            orderId,
            totalAmount,
            paidAmount,
            dueAmount,
            paymentType,
            buyerName,
            buyerPhone,
            delivery,
            itemsText,
        } = req.body;

        if (!orderId) {
            return res.status(400).json({ error: "orderId missing" });
        }

        await appendOrderToOrdersLog({
            orderId,
            source: "bot",
            totalAmount: totalAmount || "",
            paidAmount: paidAmount || "",
            dueAmount: dueAmount || "",
            paymentType: paymentType || "",
            buyerName: buyerName || "",
            buyerPhone: buyerPhone || "",
            delivery: delivery || "",
            itemsText: itemsText || "",
        });

        res.json({ ok: true });
    } catch (e) {
        console.error("BOT LOG ERROR:", e);
        res.status(500).json({ error: "failed to log bot order" });
    }
});


/* ===================== GET ACTIVE ORDERS ===================== */

app.get("/admin/active-orders", async (req, res) => {
    try {
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: "ORDERS_LOG!A:Z",
        });

        const rows = result.data.values || [];

        if (rows.length < 2) {
            return res.json([]);
        }

        const data = rows.slice(1).map((r) => ({
            orderId: r[0] || "",        // ID замовлення
            source: r[1] || "",         // Джерело
            paidAt: r[2] || "",         // Дата оплати
            totalAmount: r[3] || "",    // Сума замовлення
            paidAmount: r[4] || "",     // Сплачено
            dueAmount: r[5] || "",      // До оплати
            paymentType: r[6] || "",    // Тип оплати
            buyerName: r[7] || "",      // Імʼя клієнта
            buyerPhone: r[8] || "",     // Телефон
            delivery: r[9] || "",       // Доставка
            itemsText: r[10] || "",     // Склад замовлення
            processed: (r[11] || "").toString().toLowerCase(),
        }));

        const activeOrders = data.filter(
            (o) => o.processed !== true && o.processed !== "true"
        );

        res.json(activeOrders);
    } catch (e) {
        console.error("ACTIVE ORDERS ERROR:", e);
        res.status(500).json({ error: "failed" });
    }
});
// ===================== 👑 ADMIN: MARK ORDER DONE =====================

app.post("/admin/mark-done", async (req, res) => {
    try {
        const { orderId } = req.body;

        if (!orderId) {
            return res.status(400).json({ error: "orderId missing" });
        }

        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: "ORDERS_LOG!A:Z",
        });

        const rows = result.data.values || [];

        if (rows.length < 2) {
            return res.status(404).json({ error: "no data" });
        }

        const header = rows[0];
        const orderIdIndex = header.indexOf("ID замовлення");
        const doneIndex = header.indexOf("Виконано");
        const doneAtIndex = header.indexOf("Дата виконання");

        if (orderIdIndex === -1 || doneIndex === -1) {
            return res.status(500).json({ error: "columns not found" });
        }

        const rowIndex = rows.findIndex(
            (r, i) => i > 0 && r[orderIdIndex] === orderId
        );

        if (rowIndex === -1) {
            return res.status(404).json({ error: "order not found" });
        }

        const now = new Date()
            .toLocaleString("sv-SE", { timeZone: "Europe/Kyiv" })
            .replace(" ", "T");

        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: `ORDERS_LOG!${String.fromCharCode(
                65 + doneIndex
            )}${rowIndex + 1}:${String.fromCharCode(
                65 + doneAtIndex
            )}${rowIndex + 1}`,
            valueInputOption: "USER_ENTERED",
            requestBody: {
                values: [[true, now]],
            },
        });

        res.json({ ok: true });
    } catch (e) {
        console.error("MARK DONE ERROR:", e);
        res.status(500).json({ error: "failed" });
    }
});


/* ===================== 👑 ADMIN: COMPLETED ORDERS ===================== */

app.get("/admin/completed-orders", async (req, res) => {
    try {
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: "ORDERS_LOG!A:Z",
        });

        const rows = result.data.values || [];

        if (rows.length < 2) {
            return res.json([]);
        }

        const headers = rows[0];

        const data = rows.slice(1).map((r) => {
            const obj = {};
            headers.forEach((h, i) => {
                obj[h] = r[i] || "";
            });
            return obj;
        });

        const completedOrders = data.filter(
            (o) =>
                o["Виконано"] === true ||
                o["Виконано"] === "TRUE" ||
                o["Виконано"] === "true"
        );

        res.json(completedOrders);
    } catch (e) {
        console.error("COMPLETED ORDERS ERROR:", e);
        res.status(500).json([]);
    }
});


/* ===================== START ===================== */

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
    console.log("Server started on port", PORT);
});
