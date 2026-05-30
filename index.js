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

function normalizeCustomerEmail(emailRaw) {
    const email = String(emailRaw || "").trim().toLowerCase();
    return email || null;
}

function normalizeCustomerPhone(phoneRaw) {
    const raw = String(phoneRaw || "").trim();
    if (!raw) return null;

    const digits = raw.replace(/\D/g, "");

    if (digits.length === 12 && digits.startsWith("38")) {
        return digits.slice(2);
    }

    if (digits.length === 10 && digits.startsWith("0")) {
        return digits;
    }

    return null;
}

app.post("/api/register", async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const email = normalizeCustomerEmail(req.body.email);
        const phone = normalizeCustomerPhone(req.body.phone);
        const password = String(req.body.password || "").trim();

        if (!name || !password) {
            return res.status(400).json({ error: "missing fields" });
        }

        if (!email && !phone) {
            return res.status(400).json({ error: "email or phone required" });
        }

        if (req.body.phone && !phone) {
            return res.status(400).json({ error: "invalid phone" });
        }

        if (email) {
            const [existingEmail] = await db.query(
                "SELECT id FROM customers WHERE LOWER(COALESCE(email, '')) = ? LIMIT 1",
                [email]
            );

            if (existingEmail.length > 0) {
                return res.status(400).json({ error: "email exists" });
            }
        }

        if (phone) {
            const [existingPhone] = await db.query(
                "SELECT id FROM customers WHERE phone = ? LIMIT 1",
                [phone]
            );

            if (existingPhone.length > 0) {
                return res.status(400).json({ error: "phone exists" });
            }
        }

        const hash = await bcrypt.hash(password, 10);

        await db.query(
            `INSERT INTO customers
             (name, email, phone, password_hash, total_spent, discount, customer_status)
             VALUES (?, ?, ?, ?, 0, 0, ?)`,
            [name, email, phone, hash, "general"]
        );

        res.json({ ok: true });

    } catch (e) {
        console.error("REGISTER ERROR:", e);
        res.status(500).json({ error: "server error" });
    }
});

/* ===================== LOGIN USER / STAFF ===================== */

function buildLoginContacts(loginRaw) {
    const raw = String(loginRaw || "").trim();
    const lower = raw.toLowerCase();
    const digits = raw.replace(/\D/g, "");

    const phones = new Set();

    if (raw) phones.add(raw);
    if (digits) phones.add(digits);

    if (digits.length === 12 && digits.startsWith("38")) {
        const local = digits.slice(2);
        phones.add(local);

        phones.add(
            `38(${digits.slice(2, 5)})${digits.slice(5, 8)}-${digits.slice(8, 10)}-${digits.slice(10, 12)}`
        );

        phones.add(
            `38(${digits.slice(2, 5)}) ${digits.slice(5, 8)}-${digits.slice(8, 10)}-${digits.slice(10, 12)}`
        );
    }

    if (digits.length === 10 && digits.startsWith("0")) {
        const full = "38" + digits;
        phones.add(full);

        phones.add(
            `38(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6, 8)}-${digits.slice(8, 10)}`
        );

        phones.add(
            `38(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 8)}-${digits.slice(8, 10)}`
        );
    }

    return {
        raw,
        lower,
        phones: Array.from(phones).filter(Boolean)
    };
}

function publicCustomer(user) {
    return {
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
    };
}

function publicStaff(staff) {
    return {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        phone: staff.phone,
        role: staff.role,
        warehouse_id: staff.warehouse_id,
        is_active: Number(staff.is_active) === 1
    };
}

app.post("/api/login", async (req, res) => {
    try {
        const loginValue = req.body.email || req.body.login || req.body.phone;
        const { password } = req.body;

        if (!loginValue || !password) {
            return res.status(400).json({ error: "missing fields" });
        }

        const login = buildLoginContacts(loginValue);
        const phonePlaceholders = login.phones.map(() => "?").join(",");

        const customerSql = `
            SELECT *
            FROM customers
            WHERE LOWER(COALESCE(email, '')) = ?
               OR phone IN (${phonePlaceholders})
            LIMIT 1
        `;

        const staffSql = `
            SELECT *
            FROM staff_users
            WHERE is_active = 1
              AND (
                    LOWER(COALESCE(email, '')) = ?
                    OR phone IN (${phonePlaceholders})
              )
            LIMIT 1
        `;

        const [customerRows] = await db.query(
            customerSql,
            [login.lower, ...login.phones]
        );

        const [staffRows] = await db.query(
            staffSql,
            [login.lower, ...login.phones]
        );

        let customerUser = null;
        let staffUser = null;

        if (customerRows.length) {
            const customer = customerRows[0];
            const customerPasswordOk = await bcrypt.compare(password, customer.password_hash);

            if (customerPasswordOk) {
                customerUser = publicCustomer(customer);
            }
        }

        if (staffRows.length) {
            const staff = staffRows[0];
            const staffPasswordOk = await bcrypt.compare(password, staff.password_hash);

            if (staffPasswordOk) {
                staffUser = publicStaff(staff);
            }
        }

        if (!customerUser && !staffUser) {
            return res.status(401).json({ error: "invalid login" });
        }

        if (customerUser && staffUser) {
            return res.json({
                ok: true,
                loginType: "both",
                user: customerUser,
                staff: staffUser
            });
        }

        if (customerUser) {
            return res.json({
                ok: true,
                loginType: "customer_only",
                user: customerUser
            });
        }

        return res.json({
            ok: true,
            loginType: "staff_only",
            staff: staffUser
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
        email,
        birthday,
        phone,
        gender,
        address,
        has_pet,
        has_car,
        travels_often
    } = req.body;

    if (!userId) {
        return res.json({ ok: false, error: "userId required" });
    }

    try {
        const fields = [];
        const values = [];

        if (email !== undefined) {
            const cleanEmail = normalizeCustomerEmail(email);

            if (cleanEmail) {
                const [existingEmail] = await db.query(
                    "SELECT id FROM customers WHERE LOWER(COALESCE(email, '')) = ? AND id <> ? LIMIT 1",
                    [cleanEmail, userId]
                );

                if (existingEmail.length > 0) {
                    return res.status(400).json({
                        ok: false,
                        error: "Цей email вже використовується"
                    });
                }
            }

            fields.push("email = ?");
            values.push(cleanEmail);
        }

        if (birthday !== undefined) {
            fields.push("birthday = ?");
            values.push(birthday || null);
        }

        if (phone !== undefined) {
            const cleanPhone = normalizeCustomerPhone(phone);

            if (phone && !cleanPhone) {
                return res.status(400).json({
                    ok: false,
                    error: "Некоректний номер телефону"
                });
            }

            if (cleanPhone) {
                const [existingPhone] = await db.query(
                    "SELECT id FROM customers WHERE phone = ? AND id <> ? LIMIT 1",
                    [cleanPhone, userId]
                );

                if (existingPhone.length > 0) {
                    return res.status(400).json({
                        ok: false,
                        error: "Цей телефон вже використовується"
                    });
                }
            }

            fields.push("phone = ?");
            values.push(cleanPhone);
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
            return res.json({ ok: false, error: "nothing to update" });
        }

        values.push(userId);

        await db.execute(
            `UPDATE customers SET ${fields.join(", ")} WHERE id = ?`,
            values
        );

        return res.json({ ok: true });

    } catch (err) {
        console.error("UPDATE PROFILE ERROR:", err);
        return res.status(500).json({ ok: false, error: "server error" });
    }
});

/* ===================== CHANGE PASSWORD ===================== */
app.post("/api/change-password", async (req, res) => {
    try {
        const userId = Number(req.body.userId || 0);
        const newPassword = String(req.body.newPassword || "").trim();

        if (!userId || !newPassword) {
            return res.status(400).json({
                ok: false,
                error: "missing fields"
            });
        }

        const hash = await bcrypt.hash(newPassword, 10);

        await db.execute(
            "UPDATE customers SET password_hash = ? WHERE id = ?",
            [hash, userId]
        );

        return res.json({ ok: true });

    } catch (err) {
        console.error("CHANGE PASSWORD ERROR:", err);
        return res.status(500).json({
            ok: false,
            error: "server error"
        });
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

let PUBLIC_PROMO_CAMPAIGNS_CACHE = {
    expiresAt: 0,
    campaigns: []
};

app.get("/api/public-promo-campaigns", async (req, res) => {
    try {
        const now = Date.now();

        if (PUBLIC_PROMO_CAMPAIGNS_CACHE.expiresAt > now) {
            return res.json({
                ok: true,
                campaigns: PUBLIC_PROMO_CAMPAIGNS_CACHE.campaigns
            });
        }

        // 1) Легка перевірка: чи є активна public-кампанія.
        // Якщо нема — не чіпаємо products_catalog.
        const [activeRows] = await db.query({
            sql: `
                SELECT id
                FROM promo_campaigns
                WHERE is_active = 1
                  AND audience = 'public'
                  AND (starts_at IS NULL OR starts_at <= NOW())
                  AND (ends_at IS NULL OR ends_at >= NOW())
                ORDER BY priority ASC, id DESC
                LIMIT 1
            `,
            timeout: 2000
        });

        if (!activeRows.length) {
            PUBLIC_PROMO_CAMPAIGNS_CACHE = {
                expiresAt: now + 5 * 60 * 1000,
                campaigns: []
            };

            return res.json({
                ok: true,
                campaigns: []
            });
        }

        // 2) Повні дані тягнемо тільки якщо активна кампанія реально є.
        const [rows] = await db.query({
            sql: `
                SELECT
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
                  AND (c.starts_at IS NULL OR c.starts_at <= NOW())
                  AND (c.ends_at IS NULL OR c.ends_at >= NOW())
                ORDER BY c.priority ASC, c.id DESC
                LIMIT 10
            `,
            timeout: 5000
        });

        PUBLIC_PROMO_CAMPAIGNS_CACHE = {
            expiresAt: now + 60 * 1000,
            campaigns: rows
        };

        return res.json({
            ok: true,
            campaigns: rows
        });

    } catch (err) {
        console.error("GET PUBLIC PROMO CAMPAIGNS ERROR:", {
            message: err.message,
            code: err.code,
            errno: err.errno
        });

        PUBLIC_PROMO_CAMPAIGNS_CACHE = {
            expiresAt: Date.now() + 60 * 1000,
            campaigns: []
        };

        return res.json({
            ok: true,
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

/* ===================== STAFF: SEARCH CUSTOMER ===================== */

app.post("/api/staff/search-customer", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);
        const searchValue = String(req.body.searchValue || "").trim();

        if (!staffId || !searchValue) {
            return res.status(400).json({
                ok: false,
                error: "missing fields"
            });
        }

        const [staffRows] = await db.query(
            "SELECT id, role, is_active FROM staff_users WHERE id = ? AND is_active = 1 LIMIT 1",
            [staffId]
        );

        if (!staffRows.length) {
            return res.status(403).json({
                ok: false,
                error: "staff access denied"
            });
        }

        const login = buildLoginContacts(searchValue);
        const phonePlaceholders = login.phones.map(() => "?").join(",");

        const [customers] = await db.query(
            `
            SELECT
                id,
                name,
                email,
                phone,
                total_spent,
                customer_status,
                welcome_discount_used
            FROM customers
            WHERE LOWER(COALESCE(email, '')) = ?
               OR phone IN (${phonePlaceholders})
            LIMIT 1
            `,
            [login.lower, ...login.phones]
        );

        if (!customers.length) {
            return res.json({
                ok: true,
                found: false
            });
        }

        const customer = customers[0];

        return res.json({
            ok: true,
            found: true,
            customer: {
                id: customer.id,
                name: customer.name,
                email: customer.email,
                phone: customer.phone,
                total_spent: customer.total_spent,
                customer_status: customer.customer_status,
                welcome_discount_used: Number(customer.welcome_discount_used) === 1,
                discount: getEffectiveDiscount(customer.customer_status, customer.total_spent)
            }
        });

    } catch (err) {
        console.error("STAFF SEARCH CUSTOMER ERROR:", err);
        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

/* ===================== STAFF: CREATE CUSTOMER ===================== */

app.post("/api/staff/create-customer", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);
        const name = String(req.body.name || "").trim();
        const email = normalizeCustomerEmail(req.body.email);
        const phone = normalizeCustomerPhone(req.body.phone);

        if (!staffId || !name || !phone) {
            return res.status(400).json({
                ok: false,
                error: "Вкажіть імʼя та телефон клієнта"
            });
        }

        if (req.body.phone && !phone) {
            return res.status(400).json({
                ok: false,
                error: "Некоректний номер телефону"
            });
        }

        const [staffRows] = await db.query(
            "SELECT id, role, is_active FROM staff_users WHERE id = ? AND is_active = 1 LIMIT 1",
            [staffId]
        );

        if (!staffRows.length) {
            return res.status(403).json({
                ok: false,
                error: "staff access denied"
            });
        }

        if (email) {
            const [existingEmail] = await db.query(
                "SELECT id FROM customers WHERE LOWER(COALESCE(email, '')) = ? LIMIT 1",
                [email]
            );

            if (existingEmail.length > 0) {
                return res.status(400).json({
                    ok: false,
                    error: "Цей email вже використовується"
                });
            }
        }

        const [existingPhone] = await db.query(
            "SELECT id FROM customers WHERE phone = ? LIMIT 1",
            [phone]
        );

        if (existingPhone.length > 0) {
            return res.status(400).json({
                ok: false,
                error: "Цей телефон вже використовується"
            });
        }

        const tempPassword = phone.slice(-4);
        const hash = await bcrypt.hash(tempPassword, 10);

        const [result] = await db.query(
            `INSERT INTO customers
             (name, email, phone, password_hash, total_spent, discount, customer_status)
             VALUES (?, ?, ?, ?, 0, 0, ?)`,
            [name, email, phone, hash, "general"]
        );

        return res.json({
            ok: true,
            customer: {
                id: result.insertId,
                name,
                email,
                phone,
                total_spent: 0,
                customer_status: "general",
                discount: 0
            },
            tempPassword
        });

    } catch (err) {
        console.error("STAFF CREATE CUSTOMER ERROR:", err);
        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

/* ===================== STAFF: GET PRODUCTS ===================== */

app.post("/api/staff/products", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);

        if (!staffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const [staffRows] = await db.query(
            "SELECT id, role, is_active FROM staff_users WHERE id = ? AND is_active = 1 LIMIT 1",
            [staffId]
        );

        if (!staffRows.length) {
            return res.status(403).json({
                ok: false,
                error: "staff access denied"
            });
        }

        const [products] = await db.query(
            `
            SELECT
                id,
                product_key,
                display_name,
                price,
                cost_price,
                realization_price,
                category_slug,
                is_active
            FROM products_catalog
            WHERE is_active = 1
            ORDER BY category_slug ASC, display_name ASC
            `
        );

        return res.json({
            ok: true,
            products
        });

    } catch (err) {
        console.error("STAFF GET PRODUCTS ERROR:", err);
        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

/* ===================== STAFF: CHECK CERTIFICATE ===================== */

app.post("/api/staff/check-certificate", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);
        const code = String(req.body.code || "").trim().toUpperCase();

        if (!staffId || !code) {
            return res.status(400).json({
                ok: false,
                valid: false,
                error: "missing fields"
            });
        }

        const [staffRows] = await db.query(
            "SELECT id, role, is_active FROM staff_users WHERE id = ? AND is_active = 1 LIMIT 1",
            [staffId]
        );

        if (!staffRows.length) {
            return res.status(403).json({
                ok: false,
                valid: false,
                error: "staff access denied"
            });
        }

        const staff = staffRows[0];

        if (!["admin", "manager", "partner"].includes(staff.role)) {
            return res.status(403).json({
                ok: false,
                valid: false,
                error: "Недостатньо прав"
            });
        }

        const sheetResult = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: `${SHEET_NAME}!A:H`,
        });

        const sheetRows = sheetResult.data.values || [];
        const sheetRow = sheetRows.find(row =>
            String(row[0] || "").trim().toUpperCase() === code
        );

        if (!sheetRow) {
            return res.json({
                ok: true,
                valid: false,
                reason: "not_found_in_google",
                message: "Сертифікат не знайдено в Google таблиці"
            });
        }

        const sheetNominal = Number(sheetRow[1] || 0);
        const sheetExpiresAt = sheetRow[3] || null;
        const sheetStatus = String(sheetRow[6] || "").trim().toLowerCase();

        const [dbRows] = await db.query(
            `
            SELECT
                certificate_code,
                nominal,
                expires_at,
                used_at,
                status
            FROM certificates
            WHERE UPPER(certificate_code) = ?
            LIMIT 1
            `,
            [code]
        );

        if (!dbRows.length) {
            return res.json({
                ok: true,
                valid: false,
                reason: "not_found_in_db",
                message: "Сертифікат не знайдено в БД"
            });
        }

        const dbCert = dbRows[0];
        const dbStatus = String(dbCert.status || "").trim().toLowerCase();

        if (sheetStatus !== "active" || dbStatus !== "active") {
            return res.json({
                ok: true,
                valid: false,
                reason: "used_or_inactive",
                message: "Сертифікат вже використаний або неактивний"
            });
        }

        const now = new Date();

        if (sheetExpiresAt && new Date(sheetExpiresAt) < now) {
            return res.json({
                ok: true,
                valid: false,
                reason: "expired_google",
                message: "Сертифікат прострочений у Google таблиці"
            });
        }

        if (dbCert.expires_at && new Date(dbCert.expires_at) < now) {
            return res.json({
                ok: true,
                valid: false,
                reason: "expired_db",
                message: "Сертифікат прострочений у БД"
            });
        }

        const dbNominal = Number(dbCert.nominal || 0);
        const nominal = dbNominal || sheetNominal;

        if (!nominal || nominal <= 0) {
            return res.json({
                ok: true,
                valid: false,
                reason: "invalid_nominal",
                message: "Некоректний номінал сертифіката"
            });
        }

        return res.json({
            ok: true,
            valid: true,
            code,
            nominal
        });

    } catch (err) {
        console.error("STAFF CHECK CERTIFICATE ERROR:", err);

        return res.status(500).json({
            ok: false,
            valid: false,
            error: "server error"
        });
    }
});

/* ===================== STAFF: CREATE MONO SALE INVOICE ===================== */

app.post("/api/staff/create-mono-sale", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const customerId = Number(req.body.customerId || 0);
        const paymentType = String(req.body.paymentType || "").trim();
        const warehouseIdFromBody = Number(req.body.warehouseId || 0);
        const allowOutOfStock = Boolean(req.body.allowOutOfStock);

        const bodyItems = Array.isArray(req.body.items) ? req.body.items : [];

        if (paymentType !== "mono_qr") {
            return res.status(400).json({
                ok: false,
                error: "Для цього маршруту доступна тільки оплата Mono QR"
            });
        }

        const saleItems = bodyItems.map(item => ({
            productId: Number(item.productId || item.product_id || 0),
            quantity: Number(item.quantity || 0)
        }));

        if (!staffId || !saleItems.length) {
            return res.status(400).json({
                ok: false,
                error: "Заповніть товари"
            });
        }

        const invalidItem = saleItems.find(item =>
            !item.productId ||
            !Number.isInteger(item.quantity) ||
            item.quantity <= 0
        );

        if (invalidItem) {
            return res.status(400).json({
                ok: false,
                error: "Усі товари мають бути обрані, кількість має бути цілим числом більше 0"
            });
        }

        const [staffRows] = await connection.query(
            `
            SELECT
                id,
                name,
                role,
                warehouse_id,
                is_active
            FROM staff_users
            WHERE id = ?
              AND is_active = 1
            LIMIT 1
            `,
            [staffId]
        );

        if (!staffRows.length) {
            return res.status(403).json({
                ok: false,
                error: "staff access denied"
            });
        }

        const staff = staffRows[0];

        if (!["admin", "manager", "partner"].includes(staff.role)) {
            return res.status(403).json({
                ok: false,
                error: "Недостатньо прав для проведення продажу"
            });
        }

        const warehouseId =
            staff.role === "admin"
                ? warehouseIdFromBody
                : Number(staff.warehouse_id || 0);

        if (!warehouseId) {
            return res.status(400).json({
                ok: false,
                error: "Оберіть склад продажу"
            });
        }

        const saleRows = [];
        const outOfStockItems = [];

        for (const saleItem of saleItems) {
            const [stockRows] = await connection.query(
                `
                SELECT
                    id,
                    warehouse_id,
                    warehouse_name,
                    product_id,
                    product_key,
                    product_display_name,
                    retail_price,
                    realization_price,
                    initial_quantity,
                    sales_quantity,
                    final_quantity
                FROM stock_balances
                WHERE warehouse_id = ?
                  AND product_id = ?
                LIMIT 1
                `,
                [warehouseId, saleItem.productId]
            );

            if (!stockRows.length) {
                return res.status(404).json({
                    ok: false,
                    error: "Товар не знайдено на обраному складі"
                });
            }

            const stock = stockRows[0];

            const currentBalance =
                stock.final_quantity !== null && stock.final_quantity !== undefined
                    ? Number(stock.final_quantity || 0)
                    : Number(stock.initial_quantity || 0) - Number(stock.sales_quantity || 0);

            if (!allowOutOfStock && currentBalance < saleItem.quantity) {
                outOfStockItems.push({
                    productName: stock.product_display_name,
                    currentBalance,
                    requestedQuantity: saleItem.quantity
                });
            }

            const unitPrice =
                stock.realization_price !== null && stock.realization_price !== undefined
                    ? Number(stock.realization_price || 0)
                    : Number(stock.retail_price || 0);

            saleRows.push({
                stock,
                quantity: saleItem.quantity,
                currentBalance,
                unitPrice,
                rowTotal: unitPrice * saleItem.quantity
            });
        }

        if (!allowOutOfStock && outOfStockItems.length) {
            return res.status(400).json({
                ok: false,
                code: "out_of_stock_confirm_required",
                outOfStockItems,
                productName: outOfStockItems[0]?.productName || "товар",
                currentBalance: outOfStockItems[0]?.currentBalance ?? 0,
                requestedQuantity: outOfStockItems[0]?.requestedQuantity ?? 0,
                error: "Недостатньо залишку по товарах у чеку"
            });
        }

        const totalAmount = saleRows.reduce((sum, row) => sum + row.rowTotal, 0);

        if (!totalAmount || totalAmount <= 0) {
            return res.status(400).json({
                ok: false,
                error: "Сума продажу має бути більше 0"
            });
        }

        const orderId = "STAFF-MONO-" + Date.now();

        const salePayload = {
            staffId,
            customerId,
            items: saleItems,
            paymentType: "mono_qr",
            warehouseId,
            certificateCode: null,
            allowOutOfStock,
            orderId
        };

        const pageUrl = await createMonoPaymentPageUrl({
            amount: totalAmount,
            orderId,
            destination: `Mōnal staff sale ${orderId}`
        });

        await connection.query(
            `
            INSERT INTO staff_mono_pending_sales
            (
                order_id,
                mono_page_url,
                staff_id,
                warehouse_id,
                customer_id,
                payment_type,
                total_amount,
                payment_amount,
                certificate_code,
                allow_out_of_stock,
                sale_payload_json,
                status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment')
            `,
            [
                orderId,
                pageUrl,
                staffId,
                warehouseId,
                customerId || null,
                "mono_qr",
                totalAmount,
                totalAmount,
                null,
                allowOutOfStock ? 1 : 0,
                JSON.stringify(salePayload)
            ]
        );

        return res.json({
            ok: true,
            orderId,
            pageUrl,
            totalAmount,
            paymentAmount: totalAmount
        });

    } catch (err) {
        console.error("STAFF CREATE MONO SALE ERROR:", err.monoData || err);

        return res.status(500).json({
            ok: false,
            error: "Не вдалося створити Mono QR оплату"
        });

    } finally {
        connection.release();
    }
});

/* ===================== STAFF: CREATE SALE ===================== */

app.post("/api/staff/create-sale", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const customerId = Number(req.body.customerId || 0);
        const paymentType = String(req.body.paymentType || "").trim();
        const warehouseIdFromBody = Number(req.body.warehouseId || 0);
        const allowOutOfStock = Boolean(req.body.allowOutOfStock);
        const certificateCode = String(req.body.certificateCode || "").trim().toUpperCase();
        const externalOrderId = String(req.body.orderId || "").trim();

        const bodyItems = Array.isArray(req.body.items) ? req.body.items : [];

        const saleItems = bodyItems.length
            ? bodyItems.map(item => ({
                productId: Number(item.productId || item.product_id || 0),
                quantity: Number(item.quantity || 0)
            }))
            : [
                {
                    productId: Number(req.body.productId || 0),
                    quantity: Number(req.body.quantity || 0)
                }
            ];

        if (!staffId || !paymentType || !saleItems.length) {
            return res.status(400).json({
                ok: false,
                error: "Заповніть товари і тип оплати"
            });
        }

        const invalidItem = saleItems.find(item =>
            !item.productId ||
            !Number.isInteger(item.quantity) ||
            item.quantity <= 0
        );

        if (invalidItem) {
            return res.status(400).json({
                ok: false,
                error: "Усі товари мають бути обрані, кількість має бути цілим числом більше 0"
            });
        }

        const [staffRows] = await connection.query(
            `
            SELECT
                id,
                name,
                role,
                warehouse_id,
                is_active
            FROM staff_users
            WHERE id = ?
              AND is_active = 1
            LIMIT 1
            `,
            [staffId]
        );

        if (!staffRows.length) {
            return res.status(403).json({
                ok: false,
                error: "staff access denied"
            });
        }

        const staff = staffRows[0];

        if (!["admin", "manager", "partner"].includes(staff.role)) {
            return res.status(403).json({
                ok: false,
                error: "Недостатньо прав для проведення продажу"
            });
        }

        const warehouseId =
            staff.role === "admin"
                ? warehouseIdFromBody
                : Number(staff.warehouse_id || 0);

        if (!warehouseId) {
            return res.status(400).json({
                ok: false,
                error: "Оберіть склад продажу"
            });
        }

        let customer = null;

        if (customerId) {
            const [customerRows] = await connection.query(
                `
                SELECT
                    id,
                    name,
                    email,
                    phone,
                    total_spent,
                    customer_status
                FROM customers
                WHERE id = ?
                LIMIT 1
                `,
                [customerId]
            );

            if (!customerRows.length) {
                return res.status(404).json({
                    ok: false,
                    error: "Клієнта не знайдено"
                });
            }

            customer = customerRows[0];
        }

        await connection.beginTransaction();

        const saleRows = [];
        const outOfStockItems = [];

        for (const saleItem of saleItems) {
            const [stockRows] = await connection.query(
                `
                SELECT
                    id,
                    warehouse_id,
                    warehouse_name,
                    product_id,
                    product_key,
                    product_display_name,
                    retail_price,
                    cost_price,
                    realization_price,
                    initial_quantity,
                    sales_quantity,
                    final_quantity
                FROM stock_balances
                WHERE warehouse_id = ?
                  AND product_id = ?
                LIMIT 1
                FOR UPDATE
                `,
                [warehouseId, saleItem.productId]
            );

            if (!stockRows.length) {
                await connection.rollback();

                return res.status(404).json({
                    ok: false,
                    error: "Товар не знайдено на обраному складі"
                });
            }

            const stock = stockRows[0];

            const currentBalance =
                stock.final_quantity !== null && stock.final_quantity !== undefined
                    ? Number(stock.final_quantity || 0)
                    : Number(stock.initial_quantity || 0) - Number(stock.sales_quantity || 0);

            if (!allowOutOfStock && currentBalance < saleItem.quantity) {
                outOfStockItems.push({
                    productName: stock.product_display_name,
                    currentBalance,
                    requestedQuantity: saleItem.quantity
                });
            }

            const unitPrice =
                stock.realization_price !== null && stock.realization_price !== undefined
                    ? Number(stock.realization_price || 0)
                    : Number(stock.retail_price || 0);

            const rowTotal = unitPrice * saleItem.quantity;

            saleRows.push({
                stock,
                quantity: saleItem.quantity,
                currentBalance,
                unitPrice,
                rowTotal
            });
        }

        if (!allowOutOfStock && outOfStockItems.length) {
            await connection.rollback();

            return res.status(400).json({
                ok: false,
                code: "out_of_stock_confirm_required",
                outOfStockItems,
                productName: outOfStockItems[0]?.productName || "товар",
                currentBalance: outOfStockItems[0]?.currentBalance ?? 0,
                requestedQuantity: outOfStockItems[0]?.requestedQuantity ?? 0,
                error: "Недостатньо залишку по товарах у чеку"
            });
        }

        const totalAmount = saleRows.reduce((sum, row) => sum + row.rowTotal, 0);
        const totalQuantity = saleRows.reduce((sum, row) => sum + row.quantity, 0);

        const paymentLabels = {
            cash: "Готівка",
            card_transfer: "Переказ на карту",
            mono_qr: "Mono QR / посилання",
            certificate: "Сертифікат",
            certificate_cash: "Сертифікат + готівка",
            certificate_mono_qr: "Сертифікат + Mono QR"
        };

        let paymentLabel = paymentLabels[paymentType] || paymentType;
        let paidAmount = totalAmount;
        let dueAmount = 0;
        let certificateToUse = null;
        let certificateNote = "";

        const isCertificatePayment =
            paymentType === "certificate" ||
            paymentType === "certificate_cash" ||
            paymentType === "certificate_mono_qr";

        if (isCertificatePayment) {
            if (!certificateCode) {
                await connection.rollback();

                return res.status(400).json({
                    ok: false,
                    error: "Вкажіть код сертифіката"
                });
            }

            const sheetResult = await sheets.spreadsheets.values.get({
                spreadsheetId: SHEET_ID,
                range: `${SHEET_NAME}!A:H`,
            });

            const sheetRows = sheetResult.data.values || [];
            const sheetRowIndex = sheetRows.findIndex(
                (row, idx) =>
                    idx > 0 &&
                    String(row[0] || "").trim().toUpperCase() === certificateCode
            );

            if (sheetRowIndex === -1) {
                await connection.rollback();

                return res.status(400).json({
                    ok: false,
                    error: "Сертифікат не знайдено в Google таблиці"
                });
            }

            const sheetRow = sheetRows[sheetRowIndex];
            const sheetStatus = String(sheetRow[6] || "").trim().toLowerCase();

            if (sheetStatus !== "active") {
                await connection.rollback();

                return res.status(400).json({
                    ok: false,
                    error: "Сертифікат вже використаний або неактивний"
                });
            }

            const [certRows] = await connection.query(
                `
                SELECT
                    certificate_code,
                    nominal,
                    expires_at,
                    used_at,
                    status
                FROM certificates
                WHERE UPPER(certificate_code) = ?
                LIMIT 1
                FOR UPDATE
                `,
                [certificateCode]
            );

            if (!certRows.length) {
                await connection.rollback();

                return res.status(400).json({
                    ok: false,
                    error: "Сертифікат не знайдено в БД"
                });
            }

            const cert = certRows[0];
            const certStatus = String(cert.status || "").trim().toLowerCase();

            if (certStatus !== "active") {
                await connection.rollback();

                return res.status(400).json({
                    ok: false,
                    error: "Сертифікат вже використаний або неактивний"
                });
            }

            if (cert.expires_at && new Date(cert.expires_at) < new Date()) {
                await connection.rollback();

                return res.status(400).json({
                    ok: false,
                    error: "Сертифікат прострочений"
                });
            }

            const certificateNominal = Number(cert.nominal || sheetRow[1] || 0);
            const certificateCoveredAmount = Math.min(certificateNominal, totalAmount);
            const certificateRestAmount = Math.max(0, totalAmount - certificateNominal);

            if (paymentType === "certificate" && certificateRestAmount > 0) {
                await connection.rollback();

                return res.status(400).json({
                    ok: false,
                    code: "certificate_extra_payment_required",
                    certificateCode,
                    certificateNominal,
                    certificateCoveredAmount,
                    certificateRestAmount,
                    error: `Сертифікат покриває ${certificateCoveredAmount} грн. До оплати ще ${certificateRestAmount} грн.`
                });
            }

            paidAmount = totalAmount;
            dueAmount = 0;

            if (paymentType === "certificate") {
                paymentLabel = "Оплачено сертифікатом 100%";
            }

            if (paymentType === "certificate_cash") {
                paymentLabel = `Сертифікат ${certificateCoveredAmount} грн + готівка ${certificateRestAmount} грн`;
            }

            if (paymentType === "certificate_mono_qr") {
                paymentLabel = `Сертифікат ${certificateCoveredAmount} грн + Mono QR ${certificateRestAmount} грн`;
            }

            certificateToUse = {
                code: certificateCode,
                sheetRowIndex,
                sheetOrderIdCell: sheetRow[5] || "",
                coveredAmount: certificateCoveredAmount,
                nominal: certificateNominal
            };

            certificateNote =
                `, сертифікат ${certificateCode}, покрито ${certificateCoveredAmount} грн`;
        }

        const orderId = externalOrderId || "STAFF-" + Date.now();

        const itemsText = saleRows.map(row =>
            `${row.stock.product_display_name} × ${row.quantity} — ${row.unitPrice} грн = ${row.rowTotal} грн`
        ).join("\n");

        for (const row of saleRows) {
            const stock = row.stock;

            await connection.query(
                `
                UPDATE stock_balances
                SET sales_quantity = sales_quantity + ?
                WHERE id = ?
                  AND warehouse_id = ?
                `,
                [row.quantity, stock.id, warehouseId]
            );

            await connection.query(
                `
                INSERT INTO stock_movements
                (
                    document_number,
                    movement_type,
                    warehouse_id,
                    warehouse_name,
                    stock_balance_id,
                    product_id,
                    product_key,
                    product_display_name,
                    quantity,
                    retail_price,
                    cost_price,
                    realization_price,
                    created_by_staff_id,
                    created_by_name
                )
                VALUES (?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    orderId,
                    stock.warehouse_id,
                    stock.warehouse_name,
                    stock.id,
                    stock.product_id,
                    stock.product_key,
                    stock.product_display_name,
                    row.quantity,
                    stock.retail_price,
                    stock.cost_price,
                    stock.realization_price,
                    staff.id,
                    staff.name
                ]
            );
        }

        const mainWarehouseName = saleRows[0]?.stock?.warehouse_name || "";

        await connection.query(
            `
            INSERT INTO orders
            (
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
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                orderId,
                customer ? customer.id : null,
                customer ? (customer.email || null) : null,
                "staff",
                customer ? (customer.name || "") : "Продаж без клієнта",
                customer ? (customer.phone || "") : "",
                mainWarehouseName,
                itemsText,
                totalAmount,
                paidAmount,
                dueAmount,
                paymentLabel,
                `Staff sale: ${staff.name || "—"} (${staff.role}), склад ${mainWarehouseName || "—"} ID ${warehouseId}${certificateNote}`
            ]
        );

        if (certificateToUse) {
            const now = new Date().toISOString();

            await sheets.spreadsheets.values.update({
                spreadsheetId: SHEET_ID,
                range: `${SHEET_NAME}!E${certificateToUse.sheetRowIndex + 1}:G${certificateToUse.sheetRowIndex + 1}`,
                valueInputOption: "USER_ENTERED",
                requestBody: {
                    values: [
                        [
                            now,
                            certificateToUse.sheetOrderIdCell || "",
                            "used"
                        ],
                    ],
                },
            });

            await connection.query(
                `
                UPDATE certificates
                SET used_at = ?, status = 'used'
                WHERE UPPER(certificate_code) = ?
                `,
                [new Date(now), certificateToUse.code]
            );
        }

        if (customer) {
            const newTotalSpent = Number(customer.total_spent || 0) + totalAmount;
            const newDiscount = getEffectiveDiscount(customer.customer_status, newTotalSpent);

            await connection.query(
                `
                UPDATE customers
                SET
                    total_spent = ?,
                    discount = ?
                WHERE id = ?
                `,
                [newTotalSpent, newDiscount, customer.id]
            );
        }

        await connection.commit();

        return res.json({
            ok: true,
            sale: {
                orderId,
                warehouseId,
                warehouseName: mainWarehouseName,
                productName:
                    saleRows.length === 1
                        ? saleRows[0].stock.product_display_name
                        : `${saleRows.length} товарних рядків`,
                quantity: totalQuantity,
                totalAmount,
                paymentLabel,
                customerName: customer ? customer.name : "Без клієнта",
                itemsText,
                items: saleRows.map(row => ({
                    productName: row.stock.product_display_name,
                    quantity: row.quantity,
                    unitPrice: row.unitPrice,
                    rowTotal: row.rowTotal,
                    stockBefore: row.currentBalance,
                    stockAfter: row.currentBalance - row.quantity
                })),
                outOfStockAllowed: saleRows.some(row => row.currentBalance < row.quantity)
            }
        });

    } catch (err) {
        await connection.rollback();

        console.error("STAFF CREATE SALE ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });

    } finally {
        connection.release();
    }
});

/* ===================== STAFF: STOCK WAREHOUSES ===================== */

app.post("/api/staff/stock-warehouses", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);

        if (!staffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const [staffRows] = await db.query(
            "SELECT id, role, is_active FROM staff_users WHERE id = ? AND is_active = 1 LIMIT 1",
            [staffId]
        );

        if (!staffRows.length) {
            return res.status(403).json({
                ok: false,
                error: "staff access denied"
            });
        }

        const staff = staffRows[0];

        if (staff.role !== "admin") {
            return res.status(403).json({
                ok: false,
                error: "admin only"
            });
        }

        const [warehouses] = await db.query(
            `
            SELECT
                warehouse_id,
                MAX(warehouse_name) AS warehouse_name,
                MAX(supplier_details) AS supplier_details,
                MAX(buyer_details) AS buyer_details,
                MAX(document_basis) AS document_basis,
                MAX(act_city) AS act_city
            FROM stock_balances
            GROUP BY warehouse_id
            ORDER BY warehouse_id ASC
            `
        );

        return res.json({
            ok: true,
            warehouses
        });

    } catch (err) {
        console.error("STAFF STOCK WAREHOUSES ERROR:", err);
        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

/* ===================== STAFF: CREATE WAREHOUSE ===================== */

app.post("/api/staff/create-warehouse", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const warehouseName = String(req.body.warehouseName || "").trim();
        const supplierDetails = String(req.body.supplierDetails || "").trim() || null;
        const buyerDetails = String(req.body.buyerDetails || "").trim() || null;
        const documentBasis = String(req.body.documentBasis || "").trim() || null;
        const actCity = String(req.body.actCity || "").trim() || null;
        
        if (!staffId || !warehouseName) {
            return res.status(400).json({
                ok: false,
                error: "missing fields"
            });
        }

        const [staffRows] = await connection.query(
            "SELECT id, role, is_active FROM staff_users WHERE id = ? AND is_active = 1 LIMIT 1",
            [staffId]
        );

        if (!staffRows.length) {
            return res.status(403).json({
                ok: false,
                error: "staff access denied"
            });
        }

        const staff = staffRows[0];

        if (staff.role !== "admin") {
            return res.status(403).json({
                ok: false,
                error: "admin only"
            });
        }

        const [sameNameRows] = await connection.query(
            `
            SELECT warehouse_id
            FROM stock_balances
            WHERE LOWER(TRIM(warehouse_name)) = LOWER(TRIM(?))
            LIMIT 1
            `,
            [warehouseName]
        );

        if (sameNameRows.length) {
            return res.status(400).json({
                ok: false,
                error: "Склад з такою назвою вже існує"
            });
        }

        await connection.beginTransaction();

        const [maxRows] = await connection.query(
            "SELECT COALESCE(MAX(warehouse_id), 0) AS maxWarehouseId FROM stock_balances"
        );

        const nextWarehouseId = Number(maxRows[0].maxWarehouseId || 0) + 1;

        const [insertResult] = await connection.query(
            `
            INSERT INTO stock_balances
            (
                warehouse_id,
                warehouse_name,
                supplier_details,
                buyer_details,
                document_basis,
                act_city,
                product_id,
                product_key,
                product_display_name,
                retail_price,
                cost_price,
                realization_price,
                initial_quantity,
                sales_quantity
            )
            SELECT
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                p.id,
                p.product_key,
                p.display_name,
                p.price,
                p.cost_price,
                p.realization_price,
                0,
                0
            FROM products_catalog p
            WHERE p.is_active = 1
            ORDER BY p.category_slug ASC, p.display_name ASC
            `,
            [nextWarehouseId, warehouseName, supplierDetails, buyerDetails, documentBasis, actCity]
        );

        await connection.commit();

        return res.json({
            ok: true,
            warehouse: {
                warehouse_id: nextWarehouseId,
                warehouse_name: warehouseName,
                supplier_details: supplierDetails,
                buyer_details: buyerDetails,
                document_basis: documentBasis,
                act_city: actCity
            },
            insertedRows: insertResult.affectedRows
        });

    } catch (err) {
        await connection.rollback();

        console.error("STAFF CREATE WAREHOUSE ERROR:", err);
        return res.status(500).json({
            ok: false,
            error: "server error"
        });

    } finally {
        connection.release();
    }
});
/* ===================== STAFF: STOCK MANAGE ITEMS ===================== */

app.post("/api/staff/stock-manage-items", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const warehouseId = Number(req.body.warehouseId || 0);

        if (!staffId || !warehouseId) {
            return res.status(400).json({
                ok: false,
                error: "missing fields"
            });
        }

        const [staffRows] = await connection.query(
            "SELECT id, role, is_active FROM staff_users WHERE id = ? AND is_active = 1 LIMIT 1",
            [staffId]
        );

        if (!staffRows.length) {
            return res.status(403).json({
                ok: false,
                error: "staff access denied"
            });
        }

        const staff = staffRows[0];

        if (staff.role !== "admin") {
            return res.status(403).json({
                ok: false,
                error: "admin only"
            });
        }

        const [warehouseRows] = await connection.query(
            `
            SELECT
                MAX(warehouse_name) AS warehouse_name,
                MAX(is_production_source) AS is_production_source
            FROM stock_balances
            WHERE warehouse_id = ?
            `,
            [warehouseId]
        );

        const warehouseName = warehouseRows[0]?.warehouse_name || "";
        const warehouseIsProduction = Number(warehouseRows[0]?.is_production_source || 0);

        if (!warehouseName) {
            return res.status(404).json({
                ok: false,
                error: "Склад не знайдено"
            });
        }

        await connection.beginTransaction();

        await connection.query(
            `
            INSERT INTO stock_balances
            (
                warehouse_id,
                warehouse_name,
                is_production_source,
                product_id,
                product_key,
                product_display_name,
                retail_price,
                cost_price,
                realization_price,
                initial_quantity,
                sales_quantity
            )
            SELECT
                ?,
                ?,
                ?,
                p.id,
                p.product_key,
                p.display_name,
                p.price,
                p.cost_price,
                p.realization_price,
                0,
                0
            FROM products_catalog p
            WHERE p.is_active = 1
              AND NOT EXISTS (
                    SELECT 1
                    FROM stock_balances sb
                    WHERE sb.warehouse_id = ?
                      AND sb.product_id = p.id
              )
            `,
            [warehouseId, warehouseName, warehouseIsProduction, warehouseId]
        );

        const [items] = await connection.query(
            `
            SELECT
                sb.id,
                sb.warehouse_id,
                sb.warehouse_name,
                sb.product_id,
                sb.product_key,
                sb.product_display_name,
                sb.retail_price,
                sb.cost_price,
                sb.realization_price,
                sb.initial_quantity,
                sb.sales_quantity,
                sb.final_quantity,
                COALESCE(ps.final_quantity, 0) AS production_final_quantity
            FROM stock_balances sb
            LEFT JOIN stock_balances ps
                ON ps.product_id = sb.product_id
               AND ps.is_production_source = 1
            WHERE sb.warehouse_id = ?
            ORDER BY sb.product_display_name ASC
            `,
            [warehouseId]
        );

        await connection.commit();

        return res.json({
            ok: true,
            warehouse: {
                warehouse_id: warehouseId,
                warehouse_name: warehouseName,
                is_production_source: warehouseIsProduction
            },
            items
        });

    } catch (err) {
        await connection.rollback();

        console.error("STAFF STOCK MANAGE ITEMS ERROR:", err);
        return res.status(500).json({
            ok: false,
            error: "server error"
        });

    } finally {
        connection.release();
    }
});

/* ===================== STAFF: RECORD STOCK MOVEMENT ===================== */

app.post("/api/staff/record-stock-movement", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const warehouseId = Number(req.body.warehouseId || 0);
        const itemsRaw = Array.isArray(req.body.items) ? req.body.items : [];

        if (!staffId || !warehouseId || !itemsRaw.length) {
            return res.status(400).json({
                ok: false,
                error: "missing fields"
            });
        }

        const [staffRows] = await connection.query(
            "SELECT id, name, role, is_active FROM staff_users WHERE id = ? AND is_active = 1 LIMIT 1",
            [staffId]
        );

        if (!staffRows.length) {
            return res.status(403).json({
                ok: false,
                error: "staff access denied"
            });
        }

        const staff = staffRows[0];

        if (staff.role !== "admin") {
            return res.status(403).json({
                ok: false,
                error: "admin only"
            });
        }

        const items = itemsRaw
            .map(item => {
                const transferInQuantity = Math.max(0, Number(item.transferInQuantity || item.quantity || 0));
                const transferOutQuantity = Math.max(0, Number(item.transferOutQuantity || 0));

                return {
                    stockId: Number(item.stockId || 0),
                    enabled: Boolean(item.enabled),
                    transferInQuantity,
                    transferOutQuantity,
                    movementQuantity: transferInQuantity > 0 ? transferInQuantity : transferOutQuantity,
                    movementType: transferOutQuantity > 0 ? "transfer_return" : "transfer_in",
                    selectedWarehouseDelta: transferInQuantity - transferOutQuantity,
                    productionTransferDelta: transferInQuantity - transferOutQuantity,
                    costPrice:
                        item.costPrice === "" || item.costPrice === null || item.costPrice === undefined
                            ? null
                            : Number(item.costPrice),
                    realizationPrice:
                        item.realizationPrice === "" || item.realizationPrice === null || item.realizationPrice === undefined
                            ? null
                            : Number(item.realizationPrice)
                };
            })
            .filter(item =>
                item.stockId &&
                item.enabled &&
                item.movementQuantity > 0
            );

        const mixedDirectionItem = items.find(item =>
            item.transferInQuantity > 0 &&
            item.transferOutQuantity > 0
        );

        if (mixedDirectionItem) {
            return res.status(400).json({
                ok: false,
                error: "В одному рядку заповніть тільки одну колонку: або “Перемістити НА склад”, або “Перемістити ЗІ складу”."
            });
        }

        if (!items.length) {
            return res.status(400).json({
                ok: false,
                error: "Оберіть товари і вкажіть кількість переміщення"
            });
        }

        await connection.beginTransaction();

        const documentNumber = "MOV-" + Date.now();
        let insertedRows = 0;

        const [productionRows] = await connection.query(
            `
            SELECT
                warehouse_id,
                MAX(warehouse_name) AS warehouse_name
            FROM stock_balances
            WHERE is_production_source = 1
            GROUP BY warehouse_id
            LIMIT 1
            `
        );

        const productionWarehouseId = Number(productionRows[0]?.warehouse_id || 0);

        if (!productionWarehouseId) {
            await connection.rollback();

            return res.status(400).json({
                ok: false,
                error: "Не знайдено склад виробництва"
            });
        }

        for (const item of items) {
            const [stockRows] = await connection.query(
                `
                SELECT
                    id,
                    warehouse_id,
                    warehouse_name,
                    is_production_source,
                    product_id,
                    product_key,
                    product_display_name,
                    retail_price,
                    cost_price,
                    realization_price
                FROM stock_balances
                WHERE id = ?
                  AND warehouse_id = ?
                LIMIT 1
                `,
                [item.stockId, warehouseId]
            );

            if (!stockRows.length) {
                continue;
            }

            const stock = stockRows[0];

            const finalCostPrice =
                item.costPrice === null ? stock.cost_price : item.costPrice;

            const finalRealizationPrice =
                item.realizationPrice === null ? stock.realization_price : item.realizationPrice;

            await connection.query(
                `
                UPDATE stock_balances
                SET
                    cost_price = ?,
                    realization_price = ?,
                    initial_quantity = initial_quantity + ?
                WHERE id = ?
                  AND warehouse_id = ?
                `,
                [
                    finalCostPrice,
                    finalRealizationPrice,
                    item.selectedWarehouseDelta,
                    stock.id,
                    warehouseId
                ]
            );

            if (Number(stock.warehouse_id) !== productionWarehouseId) {
                const [productionStockRows] = await connection.query(
                    `
                    SELECT
                        id,
                        transfer_out_quantity
                    FROM stock_balances
                    WHERE warehouse_id = ?
                      AND product_id = ?
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [productionWarehouseId, stock.product_id]
                );

                if (!productionStockRows.length) {
                    await connection.rollback();

                    return res.status(400).json({
                        ok: false,
                        error: `Товар "${stock.product_display_name}" не знайдено на складі виробництва`
                    });
                }

                const currentProductionTransferOut = Number(productionStockRows[0].transfer_out_quantity || 0);

                if (
                    item.productionTransferDelta < 0 &&
                    currentProductionTransferOut < Math.abs(item.productionTransferDelta)
                ) {
                    await connection.rollback();

                    return res.status(400).json({
                        ok: false,
                        error: `Неможливо повернути "${stock.product_display_name}" більше, ніж було переміщено зі складу виробництва`
                    });
                }

                await connection.query(
                    `
                    UPDATE stock_balances
                    SET transfer_out_quantity = transfer_out_quantity + ?
                    WHERE id = ?
                      AND warehouse_id = ?
                    `,
                    [
                        item.productionTransferDelta,
                        productionStockRows[0].id,
                        productionWarehouseId
                    ]
                );
            }

            await connection.query(
                `
                INSERT INTO stock_movements
                (
                    document_number,
                    movement_type,
                    warehouse_id,
                    warehouse_name,
                    stock_balance_id,
                    product_id,
                    product_key,
                    product_display_name,
                    quantity,
                    retail_price,
                    cost_price,
                    realization_price,
                    created_by_staff_id,
                    created_by_name
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    documentNumber,
                    item.movementType,
                    stock.warehouse_id,
                    stock.warehouse_name,
                    stock.id,
                    stock.product_id,
                    stock.product_key,
                    stock.product_display_name,
                    item.movementQuantity,
                    stock.retail_price,
                    finalCostPrice,
                    finalRealizationPrice,
                    staff.id,
                    staff.name
                ]
            );

            insertedRows++;
        }

        if (!insertedRows) {
            await connection.rollback();

            return res.status(400).json({
                ok: false,
                error: "Жоден товар не записано"
            });
        }

        await connection.commit();

        return res.json({
            ok: true,
            documentNumber,
            insertedRows
        });

    } catch (err) {
        await connection.rollback();

        console.error("STAFF RECORD STOCK MOVEMENT ERROR:", err);
        return res.status(500).json({
            ok: false,
            error: "server error"
        });

    } finally {
        connection.release();
    }
});

/* ===================== STAFF: STOCK MOVEMENT ACTS ARCHIVE ===================== */

app.post("/api/staff/stock-movement-acts", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);
        const warehouseIdRaw = req.body.warehouseId;
        const warehouseId = warehouseIdRaw ? Number(warehouseIdRaw) : null;

        if (!staffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const [staffRows] = await db.query(
            "SELECT id, role, is_active FROM staff_users WHERE id = ? AND is_active = 1 LIMIT 1",
            [staffId]
        );

        if (!staffRows.length) {
            return res.status(403).json({
                ok: false,
                error: "staff access denied"
            });
        }

        const staff = staffRows[0];

        if (staff.role !== "admin") {
            return res.status(403).json({
                ok: false,
                error: "admin only"
            });
        }

        let sql = `
            SELECT
                document_number,
                warehouse_id,
                MAX(warehouse_name) AS warehouse_name,
                MIN(created_at) AS created_at,
                MAX(created_by_name) AS created_by_name,
                COUNT(*) AS items_count,
                SUM(quantity) AS total_quantity,
                SUM(quantity * COALESCE(realization_price, retail_price, 0)) AS total_amount
            FROM stock_movements
            WHERE movement_type IN ('transfer_in', 'transfer_return')
        `;

        const params = [];

        if (warehouseId) {
            sql += " AND warehouse_id = ?";
            params.push(warehouseId);
        }

        sql += `
            GROUP BY document_number, warehouse_id
            ORDER BY created_at DESC
        `;

        const [acts] = await db.query(sql, params);

        return res.json({
            ok: true,
            acts
        });

    } catch (err) {
        console.error("STAFF STOCK MOVEMENT ACTS ARCHIVE ERROR:", err);
        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

/* ===================== STAFF: STOCK ACT ===================== */

app.post("/api/staff/stock-act", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);
        const documentNumber = String(req.body.documentNumber || "").trim();

        if (!staffId || !documentNumber) {
            return res.status(400).json({
                ok: false,
                error: "missing fields"
            });
        }

        const [staffRows] = await db.query(
            "SELECT id, role, is_active FROM staff_users WHERE id = ? AND is_active = 1 LIMIT 1",
            [staffId]
        );

        if (!staffRows.length) {
            return res.status(403).json({
                ok: false,
                error: "staff access denied"
            });
        }

        const staff = staffRows[0];

        if (staff.role !== "admin") {
            return res.status(403).json({
                ok: false,
                error: "admin only"
            });
        }

        const [docRows] = await db.query(
            `
            SELECT
                document_number,
                movement_type,
                warehouse_id,
                MAX(warehouse_name) AS warehouse_name,
                MIN(created_at) AS created_at,
                MAX(created_by_name) AS created_by_name
            FROM stock_movements
            WHERE document_number = ?
            GROUP BY document_number, movement_type, warehouse_id
            LIMIT 1
            `,
            [documentNumber]
        );

        if (!docRows.length) {
            return res.status(404).json({
                ok: false,
                error: "Акт не знайдено"
            });
        }

        const doc = docRows[0];

        const [warehouseRows] = await db.query(
            `
            SELECT
                MAX(supplier_details) AS supplier_details,
                MAX(buyer_details) AS buyer_details,
                MAX(document_basis) AS document_basis,
                MAX(act_city) AS act_city
            FROM stock_balances
            WHERE warehouse_id = ?
            `,
            [doc.warehouse_id]
        );

        const warehouseDetails = warehouseRows[0] || {};

        const [items] = await db.query(
            `
            SELECT
                movement_type,
                product_display_name,
                quantity,
                retail_price,
                cost_price,
                realization_price
            FROM stock_movements
            WHERE document_number = ?
            ORDER BY product_display_name ASC
            `,
            [documentNumber]
        );

        return res.json({
            ok: true,
            act: {
                document_number: doc.document_number,
                warehouse_id: doc.warehouse_id,
                warehouse_name: doc.warehouse_name,
                created_at: doc.created_at,
                created_by_name: doc.created_by_name,
                supplier_details: warehouseDetails.supplier_details || "",
                buyer_details: warehouseDetails.buyer_details || "",
                document_basis: warehouseDetails.document_basis || "",
                act_city: warehouseDetails.act_city || ""
            },
            items
        });

    } catch (err) {
        console.error("STAFF STOCK ACT ERROR:", err);
        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

/* ===================== STAFF: STOCK MOVEMENT REPORT ===================== */

app.post("/api/staff/stock-movement-report", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);
        const warehouseIdRaw = req.body.warehouseId;
        const warehouseId = warehouseIdRaw ? Number(warehouseIdRaw) : null;
        const startDate = String(req.body.startDate || "").trim();
        const endDate = String(req.body.endDate || "").trim();

        if (!staffId || !startDate || !endDate) {
            return res.status(400).json({
                ok: false,
                error: "Оберіть склад і період звіту"
            });
        }

        if (
            !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
            !/^\d{4}-\d{2}-\d{2}$/.test(endDate)
        ) {
            return res.status(400).json({
                ok: false,
                error: "Некоректний формат дати"
            });
        }

        const startAt = `${startDate} 00:00:00`;

        const endDateObj = new Date(`${endDate}T00:00:00.000Z`);
        endDateObj.setUTCDate(endDateObj.getUTCDate() + 1);

        const endExclusive =
            endDateObj.toISOString().slice(0, 10) + " 00:00:00";

        const [staffRows] = await db.query(
            "SELECT id, role, is_active FROM staff_users WHERE id = ? AND is_active = 1 LIMIT 1",
            [staffId]
        );

        if (!staffRows.length) {
            return res.status(403).json({
                ok: false,
                error: "staff access denied"
            });
        }

        const staff = staffRows[0];

        if (staff.role !== "admin") {
            return res.status(403).json({
                ok: false,
                error: "admin only"
            });
        }

        const [productionRows] = await db.query(
            `
            SELECT
                warehouse_id,
                MAX(warehouse_name) AS warehouse_name
            FROM stock_balances
            WHERE is_production_source = 1
            GROUP BY warehouse_id
            LIMIT 1
            `
        );

        if (!productionRows.length) {
            return res.status(400).json({
                ok: false,
                error: "Не знайдено склад виробництва"
            });
        }

        const productionWarehouseId = Number(productionRows[0].warehouse_id || 0);

        let stockSql = `
            SELECT
                warehouse_id,
                warehouse_name,
                is_production_source,
                product_id,
                product_key,
                product_display_name,
                retail_price,
                final_quantity
            FROM stock_balances
        `;

        const stockParams = [];

        if (warehouseId) {
            stockSql += " WHERE warehouse_id = ?";
            stockParams.push(warehouseId);
        }

        stockSql += `
            ORDER BY warehouse_id ASC, product_display_name ASC
        `;

        const [stockRows] = await db.query(stockSql, stockParams);

        const [periodMovements] = await db.query(
            `
            SELECT
                warehouse_id,
                warehouse_name,
                product_id,
                movement_type,
                quantity
            FROM stock_movements
            WHERE created_at >= ?
              AND created_at < ?
              AND movement_type IN ('transfer_in', 'transfer_return', 'sale')
            `,
            [startAt, endExclusive]
        );

        const [afterStartMovements] = await db.query(
            `
            SELECT
                warehouse_id,
                warehouse_name,
                product_id,
                movement_type,
                quantity
            FROM stock_movements
            WHERE created_at >= ?
              AND movement_type IN ('transfer_in', 'transfer_return', 'sale')
            `,
            [startAt]
        );

        function calcWarehouseProductMovement(stockRow, movements) {
            const rowWarehouseId = Number(stockRow.warehouse_id || 0);
            const productId = Number(stockRow.product_id || 0);
            const isProduction = Number(stockRow.is_production_source || 0) === 1;

            let incoming = 0;
            let transferOut = 0;
            let sales = 0;

            movements.forEach(movement => {
                const movementWarehouseId = Number(movement.warehouse_id || 0);
                const movementProductId = Number(movement.product_id || 0);
                const movementType = String(movement.movement_type || "");
                const quantity = Number(movement.quantity || 0);

                if (movementProductId !== productId) return;

                if (isProduction) {
                    if (
                        movementWarehouseId === productionWarehouseId &&
                        movementType === "transfer_in"
                    ) {
                        incoming += quantity;
                    }

                    if (
                        movementWarehouseId !== productionWarehouseId &&
                        movementType === "transfer_return"
                    ) {
                        incoming += quantity;
                    }

                    if (
                        movementWarehouseId !== productionWarehouseId &&
                        movementType === "transfer_in"
                    ) {
                        transferOut += quantity;
                    }

                    if (
                        movementWarehouseId === productionWarehouseId &&
                        movementType === "sale"
                    ) {
                        sales += quantity;
                    }

                    return;
                }

                if (
                    movementWarehouseId === rowWarehouseId &&
                    movementType === "transfer_in"
                ) {
                    incoming += quantity;
                }

                if (
                    movementWarehouseId === rowWarehouseId &&
                    movementType === "transfer_return"
                ) {
                    transferOut += quantity;
                }

                if (
                    movementWarehouseId === rowWarehouseId &&
                    movementType === "sale"
                ) {
                    sales += quantity;
                }
            });

            return {
                incoming,
                transferOut,
                sales
            };
        }

        const items = stockRows
            .map(row => {
                const period = calcWarehouseProductMovement(row, periodMovements);
                const afterStart = calcWarehouseProductMovement(row, afterStartMovements);

                const currentFinal = Number(row.final_quantity || 0);

                const openingQuantity =
                    currentFinal -
                    Number(afterStart.incoming || 0) +
                    Number(afterStart.transferOut || 0) +
                    Number(afterStart.sales || 0);

                const closingQuantity =
                    openingQuantity +
                    Number(period.incoming || 0) -
                    Number(period.transferOut || 0) -
                    Number(period.sales || 0);

                return {
                    warehouse_id: Number(row.warehouse_id || 0),
                    warehouse_name: row.warehouse_name,
                    product_id: Number(row.product_id || 0),
                    product_key: row.product_key,
                    product_display_name: row.product_display_name,
                    retail_price: Number(row.retail_price || 0),

                    opening_quantity: openingQuantity,
                    incoming_quantity: Number(period.incoming || 0),
                    transfer_out_quantity: Number(period.transferOut || 0),
                    sales_quantity: Number(period.sales || 0),
                    closing_quantity: closingQuantity
                };
            })
            .filter(item =>
                item.opening_quantity !== 0 ||
                item.incoming_quantity !== 0 ||
                item.transfer_out_quantity !== 0 ||
                item.sales_quantity !== 0 ||
                item.closing_quantity !== 0
            );

        const totals = items.reduce(
            (acc, item) => {
                acc.opening_quantity += Number(item.opening_quantity || 0);
                acc.incoming_quantity += Number(item.incoming_quantity || 0);
                acc.transfer_out_quantity += Number(item.transfer_out_quantity || 0);
                acc.sales_quantity += Number(item.sales_quantity || 0);
                acc.closing_quantity += Number(item.closing_quantity || 0);
                return acc;
            },
            {
                opening_quantity: 0,
                incoming_quantity: 0,
                transfer_out_quantity: 0,
                sales_quantity: 0,
                closing_quantity: 0
            }
        );

        const selectedWarehouse = warehouseId
            ? stockRows.find(row => Number(row.warehouse_id || 0) === warehouseId)
            : null;

        return res.json({
            ok: true,
            scope: {
                warehouse_id: warehouseId,
                warehouse_name: selectedWarehouse
                    ? selectedWarehouse.warehouse_name
                    : "Всі склади"
            },
            period: {
                startDate,
                endDate
            },
            items,
            totals
        });

    } catch (err) {
        console.error("STAFF STOCK MOVEMENT REPORT ERROR:", err);
        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});
/* ===================== STAFF: STOCK REPORT ===================== */

app.post("/api/staff/stock-report", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);
        const warehouseIdRaw = req.body.warehouseId;
        const warehouseId = warehouseIdRaw ? Number(warehouseIdRaw) : null;

        if (!staffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const [staffRows] = await db.query(
            "SELECT id, role, is_active FROM staff_users WHERE id = ? AND is_active = 1 LIMIT 1",
            [staffId]
        );

        if (!staffRows.length) {
            return res.status(403).json({
                ok: false,
                error: "staff access denied"
            });
        }

        const staff = staffRows[0];

        if (staff.role !== "admin") {
            return res.status(403).json({
                ok: false,
                error: "admin only"
            });
        }

        let sql = `
            SELECT
                warehouse_id,
                warehouse_name,
                product_id,
                product_key,
                product_display_name,
                retail_price,
                cost_price,
                realization_price,
                initial_quantity,
                sales_quantity,
                final_quantity
            FROM stock_balances
        `;

        const params = [];

        if (warehouseId) {
            sql += " WHERE warehouse_id = ?";
            params.push(warehouseId);
        }

        sql += `
            ORDER BY
                warehouse_id ASC,
                product_display_name ASC
        `;

        const [items] = await db.query(sql, params);

        return res.json({
            ok: true,
            items
        });

    } catch (err) {
        console.error("STAFF STOCK REPORT ERROR:", err);
        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

/* ===================== STAFF: MY STOCK ===================== */

app.post("/api/staff/my-stock", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);

        if (!staffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const [staffRows] = await db.query(
            `
            SELECT
                id,
                role,
                warehouse_id,
                is_active
            FROM staff_users
            WHERE id = ?
              AND is_active = 1
            LIMIT 1
            `,
            [staffId]
        );

        if (!staffRows.length) {
            return res.status(403).json({
                ok: false,
                error: "staff access denied"
            });
        }

        const staff = staffRows[0];

        if (!["manager", "partner"].includes(staff.role)) {
            return res.status(403).json({
                ok: false,
                error: "manager or partner only"
            });
        }

        const warehouseId = Number(staff.warehouse_id || 0);

        if (!warehouseId) {
            return res.status(400).json({
                ok: false,
                error: "До staff-акаунта не привʼязано склад"
            });
        }

        const [items] = await db.query(
            `
            SELECT
                warehouse_id,
                warehouse_name,
                product_display_name,
                initial_quantity,
                sales_quantity,
                final_quantity
            FROM stock_balances
            WHERE warehouse_id = ?
              AND (
                    initial_quantity > 0
                    OR sales_quantity > 0
                    OR final_quantity > 0
              )
            ORDER BY product_display_name ASC
            `,
            [warehouseId]
        );

        return res.json({
            ok: true,
            warehouse: {
                warehouse_id: warehouseId,
                warehouse_name: items[0]?.warehouse_name || ""
            },
            items
        });

    } catch (err) {
        console.error("STAFF MY STOCK ERROR:", err);
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
app.post("/register-order", async (req, res) => {
    try {
        const {
            orderId,
            text,
            userId,
            userEmail,
            customerStatus,
            welcomeDiscountUsed,
            focusProductDiscount,
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

        const source = req.body.source || "site";
        const cleanEmail = String(userEmail || "").trim().toLowerCase();

        let customerDbId = null;
        let finalUserEmail = userEmail || null;

        // Для сайту userId вже є ID клієнта з MySQL
        if (source !== "bot" && userId) {
            customerDbId = userId;
        }

        // Для Telegram-бота userId = Telegram ID.
        // Тому клієнта шукаємо окремо по email.
        if (source === "bot" && cleanEmail) {
            const [customers] = await db.query(
                "SELECT id, email FROM customers WHERE LOWER(email) = ? LIMIT 1",
                [cleanEmail]
            );

            if (customers.length) {
                customerDbId = customers[0].id;
                finalUserEmail = customers[0].email;
            } else {
                customerDbId = null;
                finalUserEmail = cleanEmail;
            }
        }

        console.log("ORDER_REGISTERED", JSON.stringify({
            orderId,
            source,
            userId,
            customerDbId,
            userEmail: finalUserEmail,
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
            source,
            userId: userId || null,
            customerDbId: customerDbId || null,
            userEmail: finalUserEmail || null,
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
            focusProductDiscount: focusProductDiscount || 0,
            personalDiscount: req.body.personalDiscount || 0,
            promoDiscount: req.body.promoDiscount || 0,
            certificateAmount: req.body.certificateAmount || 0,
        });

        res.json({ ok: true });
    } catch (err) {
        console.error("REGISTER ORDER ERROR:", err);
        res.status(500).json({ error: "server error" });
    }
});
   
/* ===================== CREATE MONO PAYMENT LINK ===================== */

async function createMonoPaymentPageUrl({
    amount,
    orderId,
    destination = null,
    redirectUrl = "https://monal.com.ua/payment-success.html"
}) {
    const numericAmount = Number(amount);

    if (!numericAmount || isNaN(numericAmount)) {
        throw new Error("Invalid amount");
    }

    if (!orderId) {
        throw new Error("Missing orderId");
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
                amount: Math.round(numericAmount * 100),
                ccy: 980,
                merchantPaymInfo: {
                    reference: orderId,
                    destination: destination || `Замовлення №${orderId}`,
                },
                redirectUrl,
                webhookUrl:
                    "https://monal-mono-pay-production.up.railway.app/mono-webhook",
            }),
        }
    );

    const data = await response.json();

    if (!response.ok || !data.pageUrl) {
        console.error("MONO ERROR:", data);

        const error = new Error("Mono payment error");
        error.monoData = data;
        throw error;
    }

    return data.pageUrl;
}

/* ===================== CREATE PAYMENT ===================== */

app.post("/create-payment", async (req, res) => {
    const { amount, orderId } = req.body;

    if (!amount || isNaN(amount)) {
        return res.status(400).json({ error: "Invalid amount" });
    }

    if (!orderId) {
        return res.status(400).json({ error: "Missing orderId" });
    }

    try {
        const pageUrl = await createMonoPaymentPageUrl({
            amount,
            orderId
        });

        return res.json({ pageUrl });

    } catch (err) {
        console.error("CREATE PAYMENT ERROR:", err.monoData || err);

        return res.status(400).json(
            err.monoData || { error: "Mono payment error" }
        );
    }
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

    const focusProductDiscount = Number(order.focusProductDiscount) || 0;
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
        (focusProductDiscount > 0
            ? `🌿 *Аромат дня:* ${focusProductDiscount} грн\n`
            : "") +
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
                order.customerDbId || (order.source === "site" ? order.userId : null),
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
            order.customerDbId || (order.source === "site" ? order.userId : null),
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

const uid = Number(
    order.customerDbId ||
    (order.source === "site" ? order.userId : 0) ||
    0
);

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

if (order.source === "bot" && order.userId) {
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

    const uid = Number(
        order.customerDbId ||
        (order.source === "site" ? order.userId : 0) ||
        0
    );

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
        source: order.source || "site",
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
