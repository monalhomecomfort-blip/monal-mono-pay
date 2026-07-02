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

function generateCertificateCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    const part1 = Array.from(
        { length: 4 },
        () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");

    const part2 = Array.from(
        { length: 4 },
        () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");

    return `${part1}-${part2}`;
}

async function generateUniqueCertificateCode(connection) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const certCode = generateCertificateCode();

        const [rows] = await connection.query(
            `
            SELECT id
            FROM certificates
            WHERE certificate_code = ?
            LIMIT 1
            `,
            [certCode]
        );

        if (!rows.length) {
            return certCode;
        }
    }

    throw new Error("Не вдалося згенерувати унікальний код сертифіката");
}

async function createPurchasedCertificate({
    connection,
    orderId,
    ownerUserId,
    nominal,
    certificateType = "фізичний"
}) {
    const createdAt = new Date();

    const expiresAt = new Date(createdAt);
    expiresAt.setMonth(createdAt.getMonth() + 3);

    const certCode = await generateUniqueCertificateCode(connection);

    await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A:H`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
            values: [
                [
                    certCode,
                    Number(nominal || 0),
                    createdAt.toISOString(),
                    expiresAt.toISOString(),
                    "",
                    orderId,
                    "active",
                    certificateType
                ]
            ]
        }
    });

    await connection.query(
        `
        INSERT INTO certificates
        (
            certificate_code,
            owner_user_id,
            purchase_order_id,
            nominal,
            created_at,
            expires_at,
            used_at,
            status,
            certificate_type
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
            certCode,
            ownerUserId || null,
            orderId,
            Number(nominal || 0),
            createdAt,
            expiresAt,
            null,
            "active",
            certificateType
        ]
    );

    return {
        code: certCode,
        nominal: Number(nominal || 0),
        expiresAt
    };
}

function isStaffCertificateStock(product) {
    const productKey = String(product?.product_key || "").trim().toLowerCase();
    const productName = String(
        product?.product_display_name ||
        product?.display_name ||
        product?.product_name ||
        ""
    ).trim().toLowerCase();

    return (
        productKey.startsWith("certificate_") ||
        productName.includes("сертифікат")
    );
}

function isStaffDiscoveryProduct(product) {
    const productKey = String(product?.product_key || "").trim().toLowerCase();
    const productName = String(
        product?.product_display_name ||
        product?.display_name ||
        product?.product_name ||
        ""
    ).trim().toLowerCase();
    const productLabel = String(product?.product_label || "").trim().toLowerCase();
    const categorySlug = String(product?.category_slug || "").trim().toLowerCase();

    return (
        categorySlug === "discovery" ||
        categorySlug === "discovery-set" ||
        productKey.includes("discovery") ||
        productName.includes("discovery") ||
        productName.includes("діскавер") ||
        productLabel.includes("discovery") ||
        productLabel.includes("діскавер")
    );
}

function isStaffTesterProduct(product) {
    const productKey = String(product?.product_key || "").trim().toLowerCase();
    const productName = String(
        product?.product_display_name ||
        product?.display_name ||
        product?.product_name ||
        ""
    ).trim().toLowerCase();
    const productLabel = String(product?.product_label || "").trim().toLowerCase();
    const categorySlug = String(product?.category_slug || "").trim().toLowerCase();

    return (
        productKey.startsWith("tester_") ||
        categorySlug.includes("tester") ||
        categorySlug.includes("testers") ||
        productLabel.includes("тестер") ||
        productName.includes("тестер")
    );
}

function isStaffStockManagedProduct(product) {
    return (
        !isStaffCertificateStock(product) &&
        !isStaffDiscoveryProduct(product)
    );
}

function normalizeStaffAromaText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/ё/g, "е")
        .replace(/[’ʼ']/g, "")
        .replace(/[_-]+/g, " ")
        .replace(/\btester\b/g, "")
        .replace(/\btesters\b/g, "")
        .replace(/тестер/g, "")
        .replace(/\b3\s*ml\b/g, "")
        .replace(/\b3\s*мл\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function isStaffDiscoveryAromaMatch(product, aromaName) {
    const aroma = normalizeStaffAromaText(aromaName);
    const productName = normalizeStaffAromaText(
        product?.product_display_name ||
        product?.display_name ||
        product?.product_name ||
        ""
    );
    const productKey = normalizeStaffAromaText(product?.product_key || "");

    if (!aroma) return false;

    return (
        productName === aroma ||
        productKey === aroma ||
        productName.includes(aroma) ||
        aroma.includes(productName) ||
        productKey.includes(aroma)
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
        is_active: Number(staff.is_active) === 1,
        can_manage_staff_users: Number(staff.can_manage_staff_users) === 1
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

/* ===================== GET PUBLIC PRODUCTS CATALOG ===================== */

app.get("/api/products-catalog-public", async (req, res) => {
    try {
        const [products] = await db.query(
            `
            SELECT
                id,
                product_key,
                display_name,
                product_label,
                category_slug,
                price
            FROM products_catalog
            WHERE is_active = 1
              AND COALESCE(staff_only, 0) = 0
            ORDER BY category_slug ASC, display_name ASC
            `
        );

        return res.json({
            ok: true,
            products
        });

    } catch (err) {
        console.error("GET PUBLIC PRODUCTS CATALOG ERROR:", err);

        return res.status(500).json({
            ok: false,
            products: [],
            error: "server error"
        });
    }
});
/* ===================== GET ACTIVE PUBLIC PROMO CAMPAIGNS ===================== */

let PUBLIC_PROMO_CAMPAIGNS_CACHE = {
    expiresAt: 0,
    campaigns: []
};

app.get("/api/public-promo-campaigns", async (req, res) => {
    try {
        await deactivateExpiredPromos(db);
        
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
                  AND (p.id IS NULL OR COALESCE(p.staff_only, 0) = 0)
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

async function isStaffVipCustomer(connection, customerId) {
    const normalizedCustomerId = Number(customerId || 0);

    if (!normalizedCustomerId) {
        return false;
    }

    const [customerRows] = await connection.query(
        `
        SELECT customer_status
        FROM customers
        WHERE id = ?
        LIMIT 1
        `,
        [normalizedCustomerId]
    );

    if (!customerRows.length) {
        return false;
    }

    const status = String(customerRows[0].customer_status || "general").toLowerCase();

    return status === "friends" || status === "partners";
}

function isStaffPublicPromoCertificateRow(row) {
    return (
        row?.isCertificateProduct ||
        isStaffCertificateStock(row?.stock)
    );
}

function normalizeStaffPublicPromoTargetText(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/ё/g, "е")
        .replace(/[’ʼ']/g, "")
        .replace(/[_/\\|–—-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getStaffPublicPromoRowCategoryKeys(row) {
    const stock = row?.stock || {};

    return [
        stock.category_slug,
        stock.product_label,
        stock.product_display_name,
        stock.catalog_display_name,
        stock.product_key
    ]
        .map(normalizeStaffPublicPromoTargetText)
        .filter(Boolean);
}

function getStaffPublicPromoTargetValues(targetSelection, prefix) {
    const rawTarget = String(targetSelection || "").trim();

    if (!rawTarget.toLowerCase().startsWith(prefix + ":")) {
        return [];
    }

    return rawTarget
        .replace(new RegExp("^" + prefix + ":", "i"), "")
        .split(",")
        .map(normalizeStaffPublicPromoTargetText)
        .filter(Boolean);
}

function getStaffPublicPromoTargetProductIds(targetSelection) {
    const rawTarget = String(targetSelection || "").trim();

    if (!rawTarget.toLowerCase().startsWith("products:")) {
        return [];
    }

    return rawTarget
        .replace(/^products:/i, "")
        .split(",")
        .map(value => Number(value || 0))
        .filter(id => Number.isInteger(id) && id > 0);
}

function isStaffPublicPercentPromoRowMatched(row, campaign) {
    if (isStaffPublicPromoCertificateRow(row)) {
        return false;
    }

    const targetSelection = String(campaign?.target_selection || "").trim();

    if (!targetSelection || targetSelection.toLowerCase() === "all") {
        return true;
    }

    if (targetSelection.toLowerCase().startsWith("products:")) {
        const productIds = getStaffPublicPromoTargetProductIds(targetSelection);
        const rowProductId = Number(row?.stock?.product_id || 0);

        return rowProductId > 0 && productIds.includes(rowProductId);
    }

    if (targetSelection.toLowerCase().startsWith("categories:")) {
        const categoryTargets = getStaffPublicPromoTargetValues(
            targetSelection,
            "categories"
        );

        if (!categoryTargets.length) {
            return false;
        }

        const rowCategoryKeys = getStaffPublicPromoRowCategoryKeys(row);

        return categoryTargets.some(target =>
            rowCategoryKeys.includes(target)
        );
    }

    return false;
}

function calculateStaffPublicCampaignDiscount(campaign, saleRows) {
    const percent = Number(campaign?.discount_percent || 0);

    if (percent <= 0) {
        return {
            discountAmount: 0,
            note: ""
        };
    }

    const promoType = String(campaign?.promo_type || "").trim();

    let eligibleRows = [];

    if (promoType === "focus_product") {
        const focusProductId = Number(campaign?.focus_product_id || 0);

        if (!focusProductId) {
            return {
                discountAmount: 0,
                note: ""
            };
        }

        eligibleRows = saleRows.filter(row =>
            !isStaffPublicPromoCertificateRow(row) &&
            Number(row?.stock?.product_id || 0) === focusProductId
        );
    }

    if (promoType === "public_percent") {
        eligibleRows = saleRows.filter(row =>
            isStaffPublicPercentPromoRowMatched(row, campaign)
        );
    }

    const eligibleTotal = eligibleRows.reduce(
        (sum, row) => sum + Number(row.rowTotal || 0),
        0
    );

    if (eligibleTotal <= 0) {
        return {
            discountAmount: 0,
            note: ""
        };
    }

    const discountAmount = Math.min(
        eligibleTotal,
        Math.round(eligibleTotal * (percent / 100))
    );

    if (discountAmount <= 0) {
        return {
            discountAmount: 0,
            note: ""
        };
    }

    const title =
        campaign?.title ||
        (
            promoType === "public_percent"
                ? "Загальна знижка"
                : "Аромат дня"
        );

    return {
        discountAmount,
        note: `${title} ${percent}%: -${discountAmount} грн`
    };
}

async function calculateStaffPublicGiftPromo(
    connection,
    saleRows,
    warehouseId,
    customerId = 0,
    options = {}
) {
    const normalizedWarehouseId = Number(warehouseId || 0);
    const allowOutOfStock = Boolean(options.allowOutOfStock);
    const lockStock = Boolean(options.lockStock);

    if (await isStaffVipCustomer(connection, customerId)) {
        return {
            isValid: true,
            campaign: null,
            giftStock: null,
            note: ""
        };
    }

    if (!normalizedWarehouseId) {
        return {
            isValid: true,
            campaign: null,
            giftStock: null,
            note: ""
        };
    }

    const [campaignRows] = await connection.query(
        `
        SELECT
            pc.id,
            pc.title,
            pc.promo_type,
            pc.focus_product_id,
            pc.target_selection,
            pc.priority
        FROM promo_campaigns pc
        INNER JOIN promo_campaign_warehouses pcw
            ON pcw.promo_campaign_id = pc.id
           AND pcw.warehouse_id = ?
        WHERE pc.is_active = 1
          AND pc.audience = 'public'
          AND pc.promo_type = 'public_gift'
          AND (pc.starts_at IS NULL OR pc.starts_at <= NOW())
          AND (pc.ends_at IS NULL OR pc.ends_at >= NOW())
        ORDER BY pc.priority ASC, pc.id DESC
        LIMIT 20
        `,
        [normalizedWarehouseId]
    );

    if (!campaignRows.length) {
        return {
            isValid: true,
            campaign: null,
            giftStock: null,
            note: ""
        };
    }

    let matchedCampaign = null;
    let matchedSaleRow = null;

    for (const campaign of campaignRows) {
        const saleRow = saleRows.find(row =>
            isStaffPublicPercentPromoRowMatched(row, campaign)
        );

        if (saleRow) {
            matchedCampaign = campaign;
            matchedSaleRow = saleRow;
            break;
        }
    }

    if (!matchedCampaign) {
        return {
            isValid: true,
            campaign: null,
            giftStock: null,
            note: ""
        };
    }

    const giftProductId = Number(matchedCampaign.focus_product_id || 0);

    if (!giftProductId) {
        return {
            isValid: false,
            error: "У загальному подарунку не вказано товар-подарунок"
        };
    }

    const lockSql = lockStock ? "FOR UPDATE" : "";

    const [giftStockRows] = await connection.query(
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
            p.product_key AS catalog_product_key,
            p.display_name AS catalog_display_name,
            p.product_label,
            p.category_slug
        FROM stock_balances sb
        LEFT JOIN products_catalog p
            ON p.id = sb.product_id
        WHERE sb.warehouse_id = ?
          AND sb.product_id = ?
        LIMIT 1
        ${lockSql}
        `,
        [
            normalizedWarehouseId,
            giftProductId
        ]
    );

    if (!giftStockRows.length) {
        return {
            isValid: false,
            error: "Товар-подарунок загальної акції не знайдено на обраному складі"
        };
    }

    const giftStock = giftStockRows[0];

    giftStock.product_display_name =
        giftStock.product_display_name ||
        giftStock.catalog_display_name ||
        "Подарунок";

    if (
        isStaffCertificateStock({
            product_key: giftStock.product_key || giftStock.catalog_product_key,
            product_display_name: giftStock.product_display_name,
            display_name: giftStock.catalog_display_name,
            product_label: giftStock.product_label,
            category_slug: giftStock.category_slug
        })
    ) {
        return {
            isValid: false,
            error: "Сертифікат не можна списати як загальний подарунок"
        };
    }

    const currentGiftBalance =
        giftStock.final_quantity !== null && giftStock.final_quantity !== undefined
            ? Number(giftStock.final_quantity || 0)
            : Number(giftStock.initial_quantity || 0) - Number(giftStock.sales_quantity || 0);

    if (!allowOutOfStock && currentGiftBalance < 1) {
        return {
            isValid: false,
            code: "out_of_stock_confirm_required",
            outOfStockItems: [
                {
                    productName: `${giftStock.product_display_name} (загальний подарунок)`,
                    currentBalance: currentGiftBalance,
                    requestedQuantity: 1
                }
            ],
            productName: `${giftStock.product_display_name} (загальний подарунок)`,
            currentBalance: currentGiftBalance,
            requestedQuantity: 1,
            error: "Недостатньо залишку по товару-подарунку"
        };
    }

    const conditionProductName = String(
        matchedSaleRow?.stock?.product_display_name ||
        matchedSaleRow?.stock?.catalog_display_name ||
        matchedSaleRow?.stock?.product_key ||
        ""
    ).trim();

    const promoNote = conditionProductName
        ? `Діє акція: у подарунок ${giftStock.product_display_name} за купівлю ${conditionProductName}.`
        : `Діє акція: у подарунок ${giftStock.product_display_name}.`;

    return {
        isValid: true,
        campaign: matchedCampaign,
        giftStock,
        note: promoNote
    };
}

async function calculateStaffFocusProductDiscount(connection, saleRows, warehouseId, customerId = 0) {
    const normalizedWarehouseId = Number(warehouseId || 0);

    if (await isStaffVipCustomer(connection, customerId)) {
        return {
            discountAmount: 0,
            note: ""
        };
    }

    if (!normalizedWarehouseId) {
        return {
            discountAmount: 0,
            note: ""
        };
    }

    const [campaignRows] = await connection.query(
        `
        SELECT
            pc.id,
            pc.title,
            pc.promo_type,
            pc.focus_product_id,
            pc.discount_percent,
            pc.target_selection,
            pc.priority
        FROM promo_campaigns pc
        INNER JOIN promo_campaign_warehouses pcw
            ON pcw.promo_campaign_id = pc.id
           AND pcw.warehouse_id = ?
        WHERE pc.is_active = 1
          AND pc.audience = 'public'
          AND pc.promo_type IN ('focus_product', 'public_percent')
          AND (pc.starts_at IS NULL OR pc.starts_at <= NOW())
          AND (pc.ends_at IS NULL OR pc.ends_at >= NOW())
        ORDER BY pc.priority ASC, pc.id DESC
        LIMIT 20
        `,
        [normalizedWarehouseId]
    );

    if (!campaignRows.length) {
        return {
            discountAmount: 0,
            note: ""
        };
    }

    for (const campaign of campaignRows) {
        const campaignDiscount = calculateStaffPublicCampaignDiscount(
            campaign,
            saleRows
        );

        if (Number(campaignDiscount.discountAmount || 0) > 0) {
            return campaignDiscount;
        }
    }

    return {
        discountAmount: 0,
        note: ""
    };
}

async function getStaffActiveFocusProductIds(connection, warehouseId) {
    const normalizedWarehouseId = Number(warehouseId || 0);

    if (!normalizedWarehouseId) {
        return new Set();
    }

    const [rows] = await connection.query(
        `
        SELECT DISTINCT
            pc.focus_product_id
        FROM promo_campaigns pc
        INNER JOIN promo_campaign_warehouses pcw
            ON pcw.promo_campaign_id = pc.id
           AND pcw.warehouse_id = ?
        WHERE pc.is_active = 1
          AND pc.audience = 'public'
          AND pc.promo_type = 'focus_product'
          AND pc.focus_product_id IS NOT NULL
          AND (pc.starts_at IS NULL OR pc.starts_at <= NOW())
          AND (pc.ends_at IS NULL OR pc.ends_at >= NOW())
        `,
        [normalizedWarehouseId]
    );

    return new Set(
        rows
            .map(row => Number(row.focus_product_id || 0))
            .filter(id => Number.isInteger(id) && id > 0)
    );
}

async function calculateStaffWelcomeDiscount(connection, saleRows, customerId, warehouseId) {
    const normalizedCustomerId = Number(customerId || 0);

    if (!normalizedCustomerId) {
        return {
            discountAmount: 0,
            note: "",
            isAvailable: false
        };
    }

    const [customerRows] = await connection.query(
        `
        SELECT
            id,
            customer_status,
            welcome_discount_used,
            total_spent
        FROM customers
        WHERE id = ?
        LIMIT 1
        `,
        [normalizedCustomerId]
    );

    if (!customerRows.length) {
        return {
            discountAmount: 0,
            note: "",
            isAvailable: false
        };
    }

    const customer = customerRows[0];

    const canUseWelcome =
        String(customer.customer_status || "general").toLowerCase() === "general" &&
        !Boolean(Number(customer.welcome_discount_used || 0)) &&
        Number(customer.total_spent || 0) <= 0;

    if (!canUseWelcome) {
        return {
            discountAmount: 0,
            note: "",
            isAvailable: false
        };
    }

    const focusProductIds = await getStaffActiveFocusProductIds(
        connection,
        warehouseId
    );

    const eligibleTotal = saleRows
        .filter(row => {
            const productId = Number(row?.stock?.product_id || 0);

            if (focusProductIds.has(productId)) {
                return false;
            }

            if (row?.isCertificateProduct) {
                return false;
            }

            if (isStaffCertificateStock(row?.stock)) {
                return false;
            }

            return true;
        })
        .reduce((sum, row) => sum + Number(row.rowTotal || 0), 0);

    if (eligibleTotal <= 0) {
        return {
            discountAmount: 0,
            note: "",
            isAvailable: true
        };
    }

    const discountAmount = Math.min(
        eligibleTotal,
        Math.round(eligibleTotal * 0.10)
    );

    return {
        discountAmount,
        note: discountAmount > 0
            ? `Welcome-знижка 10%: -${discountAmount} грн`
            : "",
        isAvailable: true
    };
}

async function calculateStaffCustomerStatusDiscount(
    connection,
    saleRows,
    customerId,
    warehouseId,
    excludeFocusProducts = false
) {
    const normalizedCustomerId = Number(customerId || 0);

    if (!normalizedCustomerId) {
        return {
            discountAmount: 0,
            note: "",
            percent: 0
        };
    }

    const [customerRows] = await connection.query(
        `
        SELECT
            id,
            customer_status,
            total_spent
        FROM customers
        WHERE id = ?
        LIMIT 1
        `,
        [normalizedCustomerId]
    );

    if (!customerRows.length) {
        return {
            discountAmount: 0,
            note: "",
            percent: 0
        };
    }

    const customer = customerRows[0];
    const discountPercent = getEffectiveDiscount(
        customer.customer_status,
        customer.total_spent
    );

    if (discountPercent <= 0) {
        return {
            discountAmount: 0,
            note: "",
            percent: 0
        };
    }

    const focusProductIds = excludeFocusProducts
        ? await getStaffActiveFocusProductIds(connection, warehouseId)
        : new Set();

    const eligibleTotal = saleRows
        .filter(row => {
            const productId = Number(row?.stock?.product_id || 0);

            if (excludeFocusProducts && focusProductIds.has(productId)) {
                return false;
            }

            if (row?.isCertificateProduct) {
                return false;
            }

            if (isStaffCertificateStock(row?.stock)) {
                return false;
            }

            return true;
        })
        .reduce((sum, row) => sum + Number(row.rowTotal || 0), 0);

    if (eligibleTotal <= 0) {
        return {
            discountAmount: 0,
            note: "",
            percent: discountPercent
        };
    }

    const discountAmount = Math.min(
        eligibleTotal,
        Math.round(eligibleTotal * (discountPercent / 100))
    );

    const status = String(customer.customer_status || "general").toLowerCase();

    const label =
        status === "friends"
            ? "Знижка друзів"
            : status === "partners"
                ? "Знижка партнера"
                : "Персональна знижка";

    return {
        discountAmount,
        note: discountAmount > 0
            ? `${label} ${discountPercent}%: -${discountAmount} грн`
            : "",
        percent: discountPercent
    };
}

function buildStaffPersonalPromoCodeItems(saleRows) {
    return (Array.isArray(saleRows) ? saleRows : []).map(row => {
        const stock = row?.stock || {};
        const productName = row?.isCertificateProduct
            ? "Сертифікат"
            : String(stock.product_display_name || stock.display_name || "");

        return {
            name: productName,
            product_name: productName,
            display_name: productName,
            label: stock.product_label || "",
            product_label: stock.product_label || "",
            category_slug: stock.category_slug || "",
            price: Number(row.unitPrice || stock.retail_price || 0),
            quantity: Number(row.quantity || 0)
        };
    });
}

async function calculateStaffPersonalPromoCodeDiscount(connection, saleRows, customerId, promoCode) {
    const cleanPromoCode = String(promoCode || "").trim().toUpperCase();

    if (!cleanPromoCode) {
        return {
            discountAmount: 0,
            note: "",
            isValid: true,
            message: "",
            promoCode: ""
        };
    }

    if (!Number(customerId || 0)) {
        return {
            discountAmount: 0,
            note: "",
            isValid: false,
            message: "Персональний промокод доступний тільки зареєстрованим клієнтам",
            promoCode: cleanPromoCode
        };
    }

    const customerStatus = await getPersonalPromoCustomerStatus(
        connection,
        customerId
    );

    if (!customerStatus) {
        return {
            discountAmount: 0,
            note: "",
            isValid: false,
            message: "Клієнта для персонального промокоду не знайдено",
            promoCode: cleanPromoCode
        };
    }

    const offer = await findActivePersonalPromoCode(
        connection,
        cleanPromoCode,
        customerStatus
    );

    const checkResult = buildPersonalPromoCheckResult(
        offer,
        buildStaffPersonalPromoCodeItems(saleRows)
    );

    if (!checkResult.valid) {
        return {
            discountAmount: 0,
            note: "",
            isValid: false,
            message: checkResult.message || "Промокод не застосовано",
            promoCode: cleanPromoCode
        };
    }

    const discountAmount = Number(checkResult.discountAmount || 0);

    return {
        discountAmount,
        note: `Промокод ${cleanPromoCode}: -${discountAmount} грн`,
        isValid: true,
        message: checkResult.message || "Знижка застосована",
        promoCode: cleanPromoCode,
        offerId: checkResult.offerId || null
    };
}

function normalizeStaffPersonalPercentTargetText(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/ё/g, "е")
        .replace(/[’ʼ']/g, "")
        .replace(/[_/\\|–—-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isStaffPersonalPercentTesterText(value) {
    const text = normalizeStaffPersonalPercentTargetText(value);

    return (
        text === "testers" ||
        text === "tester" ||
        text.includes("tester") ||
        text.includes("тестер")
    );
}

function isStaffPersonalPercentCertificateText(value) {
    const text = normalizeStaffPersonalPercentTargetText(value);

    return (
        text === "certificates" ||
        text === "certificate" ||
        text.includes("certificate") ||
        text.includes("сертиф")
    );
}

function getStaffPersonalPercentCategoryKeys(value) {
    const text = normalizeStaffPersonalPercentTargetText(value);
    const keys = new Set();

    if (!text) {
        return [];
    }

    if (
        text === "all" ||
        text === "всі" ||
        text === "всі категорії"
    ) {
        keys.add("all");
        return Array.from(keys);
    }

    if (isStaffPersonalPercentCertificateText(text)) {
        keys.add("certificates");
        return Array.from(keys);
    }

    if (isStaffPersonalPercentTesterText(text)) {
        keys.add("testers");
        return Array.from(keys);
    }

    if (
        text === "aromadiffusers" ||
        text === "aromadiffuser" ||
        text.includes("аромадифузор") ||
        text.includes("diffuser")
    ) {
        keys.add("aromadiffusers");
    }

    if (
        text === "refills" ||
        text === "refill" ||
        text.includes("рефіл") ||
        text.includes("refill")
    ) {
        keys.add("refills");
    }

    if (
        text === "parfums" ||
        text === "parfum" ||
        text === "perfume" ||
        text.includes("parfum") ||
        text.includes("perfume") ||
        text.includes("парфум")
    ) {
        keys.add("parfums");
    }

    if (
        text === "discovery" ||
        text === "discovery set" ||
        text === "discovery-set" ||
        text.includes("discovery") ||
        text.includes("діскавер")
    ) {
        keys.add("discovery");
    }

    if (
        text === "gift-sets" ||
        text === "gift sets" ||
        text.includes("gift") ||
        text.includes("подарунков")
    ) {
        keys.add("gift-sets");
    }

    return Array.from(keys).filter(Boolean);
}

function getStaffPersonalPercentRowCategoryKeys(row) {
    const stock = row?.stock || {};

    if (
        row?.isCertificateProduct ||
        isStaffCertificateStock(stock)
    ) {
        return ["certificates"];
    }

    const testerValues = [
        stock.category_slug,
        stock.product_label,
        stock.product_key,
        stock.product_display_name,
        stock.catalog_display_name
    ];

    if (
        testerValues
            .map(value => normalizeStaffPersonalPercentTargetText(value))
            .some(value => isStaffPersonalPercentTesterText(value))
    ) {
        return ["testers"];
    }

    const values = [
        stock.category_slug,
        stock.product_label,
        stock.product_key,
        stock.product_display_name,
        stock.catalog_display_name
    ];

    return [
        ...new Set(
            values.flatMap(value => getStaffPersonalPercentCategoryKeys(value))
        )
    ].filter(key => key && key !== "all" && key !== "certificates");
}

function isStaffPersonalPercentRowMatched(row, offer) {
    if (
        row?.isCertificateProduct ||
        isStaffCertificateStock(row?.stock)
    ) {
        return false;
    }

    const rawCategories = String(offer?.required_category_slug || "").trim();

    if (!rawCategories || rawCategories.toLowerCase() === "all") {
        return true;
    }

    const offerCategoryKeys = [
        ...new Set(
            rawCategories
                .split(",")
                .flatMap(value => getStaffPersonalPercentCategoryKeys(value))
                .filter(key => key && key !== "all" && key !== "certificates")
        )
    ];

    if (!offerCategoryKeys.length) {
        return false;
    }

    const rowCategoryKeys = getStaffPersonalPercentRowCategoryKeys(row);

    if (!rowCategoryKeys.length) {
        return false;
    }

    return offerCategoryKeys.some(key =>
        rowCategoryKeys.includes(key)
    );
}

async function calculateStaffSelectedPersonalPercentOfferDiscount(
    connection,
    saleRows,
    customerId,
    offerId,
    maxDiscountBase = Infinity
) {
    const normalizedOfferId = Number(offerId || 0);
    const normalizedCustomerId = Number(customerId || 0);

    if (!normalizedOfferId) {
        return {
            discountAmount: 0,
            note: "",
            isValid: true,
            message: "",
            offerId: 0
        };
    }

    if (!normalizedCustomerId) {
        return {
            discountAmount: 0,
            note: "",
            isValid: false,
            message: "Персональна % знижка доступна тільки зареєстрованим клієнтам",
            offerId: normalizedOfferId
        };
    }

    const customerStatus = await getPersonalPromoCustomerStatus(
        connection,
        normalizedCustomerId
    );

    if (!customerStatus) {
        return {
            discountAmount: 0,
            note: "",
            isValid: false,
            message: "Клієнта для персональної % знижки не знайдено",
            offerId: normalizedOfferId
        };
    }

    const [offerRows] = await connection.query(
        `
        SELECT
            id,
            title,
            offer_text,
            offer_type,
            discount_percent,
            required_category_slug,
            COALESCE(required_customer_status, 'all') AS required_customer_status
        FROM personal_offers
        WHERE id = ?
          AND offer_type = 'discount'
          AND is_active = 1
          AND COALESCE(discount_percent, 0) > 0
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (ends_at IS NULL OR ends_at >= NOW())
          AND (
                COALESCE(required_customer_status, '') = ''
                OR FIND_IN_SET('all', REPLACE(LOWER(COALESCE(required_customer_status, 'all')), ' ', '')) > 0
                OR FIND_IN_SET(?, REPLACE(LOWER(COALESCE(required_customer_status, 'all')), ' ', '')) > 0
          )
        LIMIT 1
        `,
        [
            normalizedOfferId,
            customerStatus
        ]
    );

    if (!offerRows.length) {
        return {
            discountAmount: 0,
            note: "",
            isValid: false,
            message: "Персональна % знижка неактивна або недоступна для цього клієнта",
            offerId: normalizedOfferId
        };
    }

    const offer = offerRows[0];
    const percent = Number(offer.discount_percent || 0);

    const eligibleTotal = saleRows
        .filter(row => isStaffPersonalPercentRowMatched(row, offer))
        .reduce((sum, row) => sum + Number(row.rowTotal || 0), 0);

    if (eligibleTotal <= 0) {
        return {
            discountAmount: 0,
            note: "",
            isValid: false,
            message: "У чеку немає товарів, на які діє персональна % знижка",
            offerId: normalizedOfferId
        };
    }

    const rawDiscountAmount = Math.round(eligibleTotal * (percent / 100));

    const discountAmount = Math.min(
        eligibleTotal,
        Number(maxDiscountBase || 0),
        rawDiscountAmount
    );

    return {
        discountAmount,
        note: `${offer.title || "Персональна % знижка"} ${percent}%: -${discountAmount} грн`,
        isValid: true,
        message: "Персональна % знижка застосована",
        offerId: normalizedOfferId
    };
}

/* ===================== STAFF: SALE PREVIEW ===================== */

app.post("/api/staff/sale-preview", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const customerId = Number(req.body.customerId || 0);
        const warehouseIdFromBody = Number(req.body.warehouseId || 0);
        const personalPromoCode = String(req.body.promoCode || "").trim().toUpperCase();
        const selectedPublicPromoCodeId = Number(req.body.selectedPublicPromoCodeId || 0);
        const skipPublicPromo = Boolean(req.body.skipPublicPromo);
        const bodyItems = Array.isArray(req.body.items) ? req.body.items : [];

        if (!staffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const [staffRows] = await connection.query(
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

        const staffUser = staffRows[0];

        const assignedWarehouseId = Number(staffUser.warehouse_id || 0);

        const warehouseId =
            assignedWarehouseId > 0
                ? assignedWarehouseId
                : String(staffUser.role || "") === "admin"
                    ? warehouseIdFromBody
                    : 0;

        const saleItems = bodyItems
            .map(item => ({
                productId: Number(item.productId || item.product_id || 0),
                quantity: Number(item.quantity || 0)
            }))
            .filter(item =>
                item.productId &&
                Number.isInteger(item.quantity) &&
                item.quantity > 0
            );

        if (!saleItems.length) {
            return res.json({
                ok: true,
                grossTotalAmount: 0,
                focusProductDiscountAmount: 0,
                focusPromoNote: "",
                availablePublicPromoCodes: [],
                selectedPublicPromoCodeId: 0,
                publicPromoCodeDiscountAmount: 0,
                publicPromoCodeNote: "",
                publicGiftPromoNote: "",
                publicGiftProductName: "",
                welcomeDiscountAmount: 0,
                welcomeDiscountNote: "",
                welcomeDiscountAvailable: false,
                totalAmount: 0
            });
        }

        const productIds = [
            ...new Set(
                saleItems
                    .map(item => item.productId)
                    .filter(id => Number.isInteger(id) && id > 0)
            )
        ];

        const placeholders = productIds.map(() => "?").join(",");

        const [products] = await connection.query(
            `
            SELECT
                id,
                product_key,
                display_name,
                product_label,
                category_slug,
                price
            FROM products_catalog
            WHERE id IN (${placeholders})
            `,
            productIds
        );

        const productsById = new Map(
            products.map(product => [
                Number(product.id || 0),
                product
            ])
        );

        const saleRows = [];

        saleItems.forEach(item => {
            const product = productsById.get(Number(item.productId || 0));

            if (!product) return;

            const unitPrice = Number(product.price || 0);
            const rowTotal = unitPrice * Number(item.quantity || 0);

            saleRows.push({
                stock: {
                    product_id: Number(product.id || 0),
                    product_key: product.product_key,
                    product_display_name: product.display_name,
                    product_label: product.product_label,
                    category_slug: product.category_slug,
                    catalog_display_name: product.display_name,
                    retail_price: unitPrice
                },
                quantity: item.quantity,
                unitPrice,
                rowTotal
            });
        });

        const grossTotalAmount = saleRows.reduce(
            (sum, row) => sum + Number(row.rowTotal || 0),
            0
        );

        const availablePublicPromoCodes = skipPublicPromo
            ? []
            : await getStaffPublicPromoCodeOptions(
                connection,
                saleRows,
                warehouseId,
                customerId
            );

        const selectedPublicPromoCodeOption = getSelectedStaffPublicPromoCodeOption(
            availablePublicPromoCodes,
            selectedPublicPromoCodeId
        );

        const selectedPublicPromoCodeAvailable =
            selectedPublicPromoCodeOption &&
            Boolean(selectedPublicPromoCodeOption.available);

        const publicPromoCodeDiscountAmount = selectedPublicPromoCodeAvailable
            ? Math.min(
                grossTotalAmount,
                Number(selectedPublicPromoCodeOption.discountAmount || 0)
            )
            : 0;

        const totalAfterPublicPromoCode = Math.max(
            0,
            grossTotalAmount - publicPromoCodeDiscountAmount
        );

        const focusPromoDiscount =
            skipPublicPromo || publicPromoCodeDiscountAmount > 0
                ? {
                    discountAmount: 0,
                    note: ""
                }
                : await calculateStaffFocusProductDiscount(
                    connection,
                    saleRows,
                    warehouseId,
                    customerId
                );

        const focusProductDiscountAmount = Math.min(
            totalAfterPublicPromoCode,
            Number(focusPromoDiscount.discountAmount || 0)
        );

        const totalAfterFocusPromo = Math.max(
            0,
            totalAfterPublicPromoCode - focusProductDiscountAmount
        );

        const publicGiftPromo =
            skipPublicPromo ||
            publicPromoCodeDiscountAmount > 0 ||
            focusProductDiscountAmount > 0
                ? {
                    isValid: true,
                    campaign: null,
                    giftStock: null,
                    note: ""
                }
                : await calculateStaffPublicGiftPromo(
                    connection,
                    saleRows,
                    warehouseId,
                    customerId,
                    {
                        allowOutOfStock: true,
                        lockStock: false
                    }
                );

        const publicGiftStock = publicGiftPromo.isValid
            ? publicGiftPromo.giftStock || null
            : null;

        const publicGiftPromoNote = publicGiftStock
            ? publicGiftPromo.note || `Діє акція: у подарунок ${publicGiftStock.product_display_name}.`
            : "";

        const welcomeDiscount = await calculateStaffWelcomeDiscount(
            connection,
            saleRows,
            customerId,
            warehouseId
        );

        const welcomeDiscountAmount = Math.min(
            totalAfterFocusPromo,
            Number(welcomeDiscount.discountAmount || 0)
        );

        const totalAfterWelcomeDiscount = Math.max(
            0,
            totalAfterFocusPromo - welcomeDiscountAmount
        );

        const statusDiscount = await calculateStaffCustomerStatusDiscount(
            connection,
            saleRows,
            customerId,
            warehouseId,
            focusProductDiscountAmount > 0
        );

        const statusDiscountAmount = Math.min(
            totalAfterWelcomeDiscount,
            Number(statusDiscount.discountAmount || 0)
        );

        const totalAfterStatusDiscount = Math.max(
            0,
            totalAfterWelcomeDiscount - statusDiscountAmount
        );

        const personalPromoCodeDiscount = await calculateStaffPersonalPromoCodeDiscount(
            connection,
            saleRows,
            customerId,
            personalPromoCode
        );

        const personalPromoCodeDiscountAmount =
            personalPromoCodeDiscount.isValid
                ? Math.min(
                    totalAfterStatusDiscount,
                    Number(personalPromoCodeDiscount.discountAmount || 0)
                )
                : 0;

        const totalAmount = Math.max(
            0,
            totalAfterStatusDiscount - personalPromoCodeDiscountAmount
        );

        return res.json({
            ok: true,
            grossTotalAmount,
            focusProductDiscountAmount,
            focusPromoNote: focusPromoDiscount.note || "",
            availablePublicPromoCodes,
            selectedPublicPromoCodeId:
                publicPromoCodeDiscountAmount > 0 && selectedPublicPromoCodeOption
                    ? Number(selectedPublicPromoCodeOption.campaignId || 0)
                    : 0,
            publicPromoCodeDiscountAmount,
            publicPromoCodeNote: publicPromoCodeDiscountAmount > 0
                ? selectedPublicPromoCodeOption.note || ""
                : "",
            publicPromoCodeMessage: selectedPublicPromoCodeOption
                ? selectedPublicPromoCodeOption.message || ""
                : "",
            publicGiftPromoNote,
            publicGiftProductName: publicGiftStock
                ? publicGiftStock.product_display_name
                : "",
            welcomeDiscountAmount,
            welcomeDiscountNote: welcomeDiscount.note || "",
            welcomeDiscountAvailable: Boolean(welcomeDiscount.isAvailable),
            statusDiscountAmount,
            statusDiscountNote: statusDiscount.note || "",
            personalPromoCodeDiscountAmount,
            personalPromoCodeNote: personalPromoCodeDiscountAmount > 0
                ? personalPromoCodeDiscount.note
                : "",
            personalPromoCodeValid: personalPromoCode
                ? Boolean(personalPromoCodeDiscount.isValid)
                : true,
            personalPromoCodeMessage: personalPromoCode
                ? personalPromoCodeDiscount.message
                : "",
            totalAmount
        });
    } catch (err) {
        console.error("STAFF SALE PREVIEW ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });

    } finally {
        connection.release();
    }
});

/* ===================== PERSONAL OFFERS / PROMO CODES ===================== */

function normalizePersonalOfferStatusForDb(value) {
    const allowedStatuses = ["all", "general", "friends", "partners"];

    const rawItems = Array.isArray(value)
        ? value
        : String(value || "all").split(",");

    const statuses = [
        ...new Set(
            rawItems
                .map(item => String(item || "").trim().toLowerCase())
                .filter(item => allowedStatuses.includes(item))
        )
    ];

    if (!statuses.length || statuses.includes("all")) {
        return "all";
    }

    return statuses.join(",");
}

function normalizePersonalOfferDateTime(value) {
    const cleanValue = String(value || "").trim();

    if (!cleanValue) return null;

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(cleanValue)) {
        return cleanValue.replace("T", " ") + ":00";
    }

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(cleanValue)) {
        return cleanValue.replace("T", " ");
    }

    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(cleanValue)) {
        return cleanValue + ":00";
    }

    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cleanValue)) {
        return cleanValue;
    }

    return null;
}

function isPersonalOfferCertificateItem(item) {
    const name = String(item?.name || item?.product_name || item?.display_name || "").toLowerCase();
    const label = String(item?.label || item?.product_label || "").toLowerCase();
    const categorySlug = String(item?.category_slug || "").toLowerCase();

    return (
        name.includes("сертиф") ||
        label.includes("сертиф") ||
        categorySlug.includes("certificate")
    );
}

function calculatePersonalPromoEligibleSum(items, offer) {
    const list = Array.isArray(items) ? items : [];

    return list
        .filter(item => !isPersonalOfferCertificateItem(item))
        .reduce((sum, item) => {
            const price = Number(item?.price || item?.unitPrice || item?.retail_price || 0);
            const quantity = Number(item?.quantity || item?.qty || 1);

            return sum + price * Math.max(1, quantity || 1);
        }, 0);
}

async function getPersonalPromoCustomerStatus(connection, userId) {
    const normalizedUserId = Number(userId || 0);

    if (!normalizedUserId) {
        return null;
    }

    const [customerRows] = await connection.query(
        `
        SELECT
            customer_status
        FROM customers
        WHERE id = ?
        LIMIT 1
        `,
        [normalizedUserId]
    );

    if (!customerRows.length) {
        return null;
    }

    return String(customerRows[0].customer_status || "general").trim().toLowerCase();
}

async function findActivePersonalPromoCode(connection, promoCode, customerStatus) {
    const normalizedCode = String(promoCode || "").trim().toUpperCase();
    const normalizedStatus = String(customerStatus || "").trim().toLowerCase();

    if (!normalizedCode || !normalizedStatus) return null;

    const [rows] = await connection.query(
        `
        SELECT
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
            COALESCE(required_customer_status, 'all') AS required_customer_status,
            is_active,
            DATE_FORMAT(starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
            DATE_FORMAT(ends_at, '%Y-%m-%d %H:%i:%s') AS ends_at
        FROM personal_offers
        WHERE offer_type = 'promo'
          AND is_active = 1
          AND UPPER(TRIM(COALESCE(promo_code, ''))) = ?
          AND COALESCE(discount_amount, 0) > 0
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (ends_at IS NULL OR ends_at >= NOW())
          AND (
                COALESCE(required_customer_status, '') = ''
                OR FIND_IN_SET('all', REPLACE(LOWER(COALESCE(required_customer_status, 'all')), ' ', '')) > 0
                OR FIND_IN_SET(?, REPLACE(LOWER(COALESCE(required_customer_status, 'all')), ' ', '')) > 0
          )
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        `,
        [
            normalizedCode,
            normalizedStatus
        ]
    );

    return rows.length ? rows[0] : null;
}

function buildPersonalPromoCheckResult(offer, items) {
    if (!offer) {
        return {
            ok: true,
            valid: false,
            discountAmount: 0,
            message: "Невірний або неактивний промокод"
        };
    }

    const eligibleSum = calculatePersonalPromoEligibleSum(items, offer);
    const minOrderAmount = Number(offer.min_order_amount || 0);
    const discountAmount = Number(offer.discount_amount || 0);

    if (eligibleSum <= 0) {
        return {
            ok: true,
            valid: false,
            discountAmount: 0,
            message: "Знижка не поширюється на товари з кошика"
        };
    }

    if (minOrderAmount > 0 && eligibleSum < minOrderAmount) {
        return {
            ok: true,
            valid: false,
            discountAmount: 0,
            minOrderAmount,
            eligibleSum,
            message: `Для цього промокоду потрібна сума від ${minOrderAmount} грн без врахування сертифікатів`
        };
    }

    const finalDiscountAmount = Math.min(
        eligibleSum,
        discountAmount
    );

    if (finalDiscountAmount <= 0) {
        return {
            ok: true,
            valid: false,
            discountAmount: 0,
            message: "Промокод не має суми знижки"
        };
    }

    return {
        ok: true,
        valid: true,
        offerId: offer.id,
        title: offer.title,
        promoCode: offer.promo_code,
        discountAmount: finalDiscountAmount,
        minOrderAmount,
        eligibleSum,
        message: "Знижка застосована"
    };
}

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

        const customerStatus = String(users[0].customer_status || "general").toLowerCase();

        await deactivateExpiredPromos(db);

        const [rows] = await db.query(
            `
            SELECT
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
                COALESCE(required_customer_status, 'all') AS required_customer_status,
                starts_at,
                ends_at
            FROM personal_offers
            WHERE is_active = 1
              AND (starts_at IS NULL OR starts_at <= NOW())
              AND (ends_at IS NULL OR ends_at >= NOW())
              AND (
                    COALESCE(required_customer_status, '') = ''
                    OR FIND_IN_SET('all', REPLACE(LOWER(COALESCE(required_customer_status, 'all')), ' ', '')) > 0
                    OR FIND_IN_SET(?, REPLACE(LOWER(COALESCE(required_customer_status, 'all')), ' ', '')) > 0
              )
            ORDER BY created_at DESC
            `,
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

/* ===================== CHECK PERSONAL PROMO CODE ===================== */

app.post("/api/promo-code/check", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const promoCode = String(req.body.promoCode || req.body.code || "").trim().toUpperCase();
        const userId = Number(req.body.userId || 0);
        const items = Array.isArray(req.body.items) ? req.body.items : [];

        if (!promoCode) {
            return res.status(400).json({
                ok: false,
                error: "missing promoCode"
            });
        }

        const customerStatus = await getPersonalPromoCustomerStatus(
            connection,
            userId
        );

        if (!customerStatus) {
            return res.json({
                ok: true,
                valid: false,
                discountAmount: 0,
                message: "Персональний промокод доступний тільки зареєстрованим клієнтам"
            });
        }

        const offer = await findActivePersonalPromoCode(
            connection,
            promoCode,
            customerStatus
        );

        return res.json(
            buildPersonalPromoCheckResult(offer, items)
        );

    } catch (err) {
        console.error("CHECK PERSONAL PROMO CODE ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });

    } finally {
        connection.release();
    }
});

/* ===================== STAFF: PERSONAL OFFERS LIST ===================== */

app.post("/api/staff/personal-offers-list", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);

        if (!staffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const adminCheck = await getAdminStaffOrDeny(staffId);

        if (!adminCheck.ok) {
            return res.status(adminCheck.status).json({
                ok: false,
                error: adminCheck.error
            });
        }

        await deactivateExpiredPromos(db);

        const [offers] = await db.query(
            `
            SELECT
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
                COALESCE(required_customer_status, 'all') AS required_customer_status,
                is_active,
                DATE_FORMAT(starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
                DATE_FORMAT(ends_at, '%Y-%m-%d %H:%i:%s') AS ends_at,
                DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
            FROM personal_offers
            ORDER BY
                offer_type ASC,
                created_at DESC,
                id DESC
            `
        );

        return res.json({
            ok: true,
            offers
        });

    } catch (err) {
        console.error("STAFF PERSONAL OFFERS LIST ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

/* ===================== STAFF: SAVE PERSONAL PROMO CODE ===================== */

app.post("/api/staff/save-personal-promo-code", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const offerId = Number(req.body.offerId || 0);

        const title = String(req.body.title || "").trim();
        const promoCode = String(req.body.promoCode || "").trim().toUpperCase();
        const discountAmount = Number(req.body.discountAmount || 0);
        const minOrderAmount = Number(req.body.minOrderAmount || 0);
        const startsAt = normalizePersonalOfferDateTime(req.body.startsAt);
        const endsAt = normalizePersonalOfferDateTime(req.body.endsAt);
        const isActive = Number(req.body.isActive) === 1 ? 1 : 0;
        const requiredCustomerStatus = normalizePersonalOfferStatusForDb(
            req.body.requiredCustomerStatus
        );

        if (!staffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const adminCheck = await getAdminStaffOrDeny(staffId);

        if (!adminCheck.ok) {
            return res.status(adminCheck.status).json({
                ok: false,
                error: adminCheck.error
            });
        }

        if (!title || !promoCode) {
            return res.status(400).json({
                ok: false,
                error: "Вкажіть назву пропозиції і промокод"
            });
        }

        if (discountAmount <= 0) {
            return res.status(400).json({
                ok: false,
                error: "Вкажіть знижку в грн більше 0"
            });
        }

        if (minOrderAmount < 0) {
            return res.status(400).json({
                ok: false,
                error: "Умова по сумі не може бути меншою за 0"
            });
        }

        if (req.body.startsAt && !startsAt) {
            return res.status(400).json({
                ok: false,
                error: "Некоректна дата початку"
            });
        }

        if (req.body.endsAt && !endsAt) {
            return res.status(400).json({
                ok: false,
                error: "Некоректна дата завершення"
            });
        }

        if (startsAt && endsAt && new Date(startsAt).getTime() >= new Date(endsAt).getTime()) {
            return res.status(400).json({
                ok: false,
                error: "Дата завершення має бути пізніше дати початку"
            });
        }

        const [duplicateRows] = await connection.query(
            `
            SELECT
                id
            FROM personal_offers
            WHERE UPPER(TRIM(COALESCE(promo_code, ''))) = ?
              AND id <> ?
            LIMIT 1
            `,
            [
                promoCode,
                offerId || 0
            ]
        );

        if (duplicateRows.length) {
            return res.status(409).json({
                ok: false,
                error: "Такий промокод вже існує"
            });
        }

        const conditionText = minOrderAmount > 0
            ? `при замовленні від ${minOrderAmount} грн без врахування сертифікатів`
            : "без мінімальної суми замовлення";

        const offerText = `Промокод ${promoCode}: знижка ${discountAmount} грн ${conditionText}.`;

        await connection.beginTransaction();

        let savedOfferId = offerId;

        if (offerId) {
            const [existingRows] = await connection.query(
                `
                SELECT
                    id
                FROM personal_offers
                WHERE id = ?
                  AND offer_type = 'promo'
                LIMIT 1
                `,
                [offerId]
            );

            if (!existingRows.length) {
                await connection.rollback();

                return res.status(404).json({
                    ok: false,
                    error: "Персональний промокод не знайдено"
                });
            }

            await connection.query(
                `
                UPDATE personal_offers
                SET
                    title = ?,
                    offer_text = ?,
                    offer_type = 'promo',
                    promo_code = ?,
                    discount_percent = NULL,
                    discount_amount = ?,
                    min_order_amount = ?,
                    required_category_slug = NULL,
                    required_discount_level = NULL,
                    required_customer_status = ?,
                    is_active = ?,
                    starts_at = ?,
                    ends_at = ?
                WHERE id = ?
                  AND offer_type = 'promo'
                `,
                [
                    title,
                    offerText,
                    promoCode,
                    discountAmount,
                    minOrderAmount,
                    requiredCustomerStatus,
                    isActive,
                    startsAt,
                    endsAt,
                    offerId
                ]
            );

        } else {
            const [result] = await connection.query(
                `
                INSERT INTO personal_offers
                (
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
                    is_active,
                    starts_at,
                    ends_at,
                    created_at
                )
                VALUES (?, ?, 'promo', ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, NOW())
                `,
                [
                    title,
                    offerText,
                    promoCode,
                    discountAmount,
                    minOrderAmount,
                    requiredCustomerStatus,
                    isActive,
                    startsAt,
                    endsAt
                ]
            );

            savedOfferId = result.insertId;
        }

        await connection.commit();

        return res.json({
            ok: true,
            offerId: savedOfferId,
            message: offerId
                ? "Персональний промокод оновлено"
                : "Персональний промокод створено"
        });

    } catch (err) {
        await connection.rollback();

        console.error("SAVE PERSONAL PROMO CODE ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });

    } finally {
        connection.release();
    }
});

/* ===================== STAFF: SAVE PERSONAL PERCENT DISCOUNT ===================== */

function normalizePersonalOfferCategoriesForDb(value) {
    const rawItems = Array.isArray(value)
        ? value
        : String(value || "all").split(",");

    const categories = [
        ...new Set(
            rawItems
                .map(item => String(item || "").trim().toLowerCase())
                .filter(item => item && item !== "all")
        )
    ];

    return categories.length ? categories.join(",") : null;
}

app.post("/api/staff/save-personal-percent-offer", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const offerId = Number(req.body.offerId || 0);

        const title = String(req.body.title || "").trim();
        const offerTextRaw = String(req.body.offerText || "").trim();
        const discountPercent = Number(req.body.discountPercent || 0);
        const startsAt = normalizePersonalOfferDateTime(req.body.startsAt);
        const endsAt = normalizePersonalOfferDateTime(req.body.endsAt);
        const isActive = Number(req.body.isActive) === 1 ? 1 : 0;

        const requiredCustomerStatus = normalizePersonalOfferStatusForDb(
            req.body.requiredCustomerStatus
        );

        const requiredCategorySlug = normalizePersonalOfferCategoriesForDb(
            req.body.requiredCategorySlug || req.body.requiredCategorySlugs || req.body.categories
        );

        if (!staffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const adminCheck = await getAdminStaffOrDeny(staffId);

        if (!adminCheck.ok) {
            return res.status(adminCheck.status).json({
                ok: false,
                error: adminCheck.error
            });
        }

        if (!title) {
            return res.status(400).json({
                ok: false,
                error: "Вкажіть назву персональної % знижки"
            });
        }

        if (discountPercent <= 0 || discountPercent > 99) {
            return res.status(400).json({
                ok: false,
                error: "Вкажіть % знижки від 1 до 99"
            });
        }

        if (req.body.startsAt && !startsAt) {
            return res.status(400).json({
                ok: false,
                error: "Некоректна дата початку"
            });
        }

        if (req.body.endsAt && !endsAt) {
            return res.status(400).json({
                ok: false,
                error: "Некоректна дата завершення"
            });
        }

        if (startsAt && endsAt && new Date(startsAt).getTime() >= new Date(endsAt).getTime()) {
            return res.status(400).json({
                ok: false,
                error: "Дата завершення має бути пізніше дати початку"
            });
        }

        const categoryText = requiredCategorySlug
            ? `на обрані категорії: ${requiredCategorySlug}`
            : "на всі категорії";

        const offerText = offerTextRaw || `Персональна знижка ${discountPercent}% ${categoryText}.`;

        await connection.beginTransaction();

        let savedOfferId = offerId;

        if (offerId) {
            const [existingRows] = await connection.query(
                `
                SELECT
                    id
                FROM personal_offers
                WHERE id = ?
                  AND offer_type = 'discount'
                LIMIT 1
                `,
                [offerId]
            );

            if (!existingRows.length) {
                await connection.rollback();

                return res.status(404).json({
                    ok: false,
                    error: "Персональну % знижку не знайдено"
                });
            }

            await connection.query(
                `
                UPDATE personal_offers
                SET
                    title = ?,
                    offer_text = ?,
                    offer_type = 'discount',
                    promo_code = NULL,
                    discount_percent = ?,
                    discount_amount = NULL,
                    min_order_amount = 0,
                    required_category_slug = ?,
                    required_discount_level = NULL,
                    required_customer_status = ?,
                    is_active = ?,
                    starts_at = ?,
                    ends_at = ?
                WHERE id = ?
                  AND offer_type = 'discount'
                `,
                [
                    title,
                    offerText,
                    discountPercent,
                    requiredCategorySlug,
                    requiredCustomerStatus,
                    isActive,
                    startsAt,
                    endsAt,
                    offerId
                ]
            );

        } else {
            const [result] = await connection.query(
                `
                INSERT INTO personal_offers
                (
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
                    is_active,
                    starts_at,
                    ends_at,
                    created_at
                )
                VALUES (?, ?, 'discount', NULL, ?, NULL, 0, ?, NULL, ?, ?, ?, ?, NOW())
                `,
                [
                    title,
                    offerText,
                    discountPercent,
                    requiredCategorySlug,
                    requiredCustomerStatus,
                    isActive,
                    startsAt,
                    endsAt
                ]
            );

            savedOfferId = result.insertId;
        }

        await connection.commit();

        return res.json({
            ok: true,
            offerId: savedOfferId,
            message: offerId
                ? "Персональну % знижку оновлено"
                : "Персональну % знижку створено"
        });

    } catch (err) {
        await connection.rollback();

        console.error("SAVE PERSONAL PERCENT DISCOUNT ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });

    } finally {
        connection.release();
    }
});

/* ===================== STAFF: SAVE PERSONAL GIFT OFFER ===================== */

function normalizePersonalGiftProductIdsForDb(value) {
    const rawItems = Array.isArray(value)
        ? value
        : String(value || "").split(",");

    const productIds = [
        ...new Set(
            rawItems
                .map(item => Number(item || 0))
                .filter(id => Number.isInteger(id) && id > 0)
        )
    ];

    return productIds.length ? productIds.join(",") : "";
}

async function getPersonalGiftProductsByIds(connection, productIdsText) {
    const productIds = String(productIdsText || "")
        .split(",")
        .map(item => Number(item || 0))
        .filter(id => Number.isInteger(id) && id > 0);

    if (!productIds.length) return [];

    const placeholders = productIds.map(() => "?").join(",");

    const [rows] = await connection.query(
        `
        SELECT
            id,
            product_key,
            display_name,
            product_label,
            category_slug
        FROM products_catalog
        WHERE id IN (${placeholders})
        `,
        productIds
    );

    const rowsById = new Map(
        rows.map(row => [
            Number(row.id || 0),
            row
        ])
    );

    return productIds
        .map(id => rowsById.get(id))
        .filter(Boolean);
}

function getPersonalGiftProductDisplayName(product) {
    return String(
        product?.display_name ||
        product?.product_name ||
        product?.product_key ||
        ""
    ).trim();
}

app.post("/api/staff/save-personal-gift-offer", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const offerId = Number(req.body.offerId || 0);

        const title = String(req.body.title || "").trim();
        const giftProductId = Number(req.body.giftProductId || 0);
        const startsAt = normalizePersonalOfferDateTime(req.body.startsAt);
        const endsAt = normalizePersonalOfferDateTime(req.body.endsAt);
        const isActive = Number(req.body.isActive) === 1 ? 1 : 0;

        const requiredCustomerStatus = normalizePersonalOfferStatusForDb(
            req.body.requiredCustomerStatus
        );

        const requiredCategorySlug = normalizePersonalOfferCategoriesForDb(
            req.body.requiredCategorySlug ||
            req.body.requiredCategorySlugs ||
            req.body.categories
        );

        const requiredProductIds = normalizePersonalGiftProductIdsForDb(
            req.body.requiredProductIds ||
            req.body.requiredProductId ||
            req.body.products
        );

        if (!staffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const adminCheck = await getAdminStaffOrDeny(staffId);

        if (!adminCheck.ok) {
            return res.status(adminCheck.status).json({
                ok: false,
                error: adminCheck.error
            });
        }

        if (!title) {
            return res.status(400).json({
                ok: false,
                error: "Вкажіть назву персонального подарунку"
            });
        }

        if (!giftProductId) {
            return res.status(400).json({
                ok: false,
                error: "Оберіть товар-подарунок"
            });
        }

        if (requiredCategorySlug && requiredProductIds) {
            return res.status(400).json({
                ok: false,
                error: "Оберіть або категорії для подарунку, або товари для подарунку, не обидва варіанти одночасно"
            });
        }

        if (!requiredCategorySlug && !requiredProductIds) {
            return res.status(400).json({
                ok: false,
                error: "Оберіть категорії або товари, за які дається подарунок"
            });
        }

        if (req.body.startsAt && !startsAt) {
            return res.status(400).json({
                ok: false,
                error: "Некоректна дата початку"
            });
        }

        if (req.body.endsAt && !endsAt) {
            return res.status(400).json({
                ok: false,
                error: "Некоректна дата завершення"
            });
        }

        if (startsAt && endsAt && new Date(startsAt).getTime() >= new Date(endsAt).getTime()) {
            return res.status(400).json({
                ok: false,
                error: "Дата завершення має бути пізніше дати початку"
            });
        }

        const [giftProductRows] = await connection.query(
            `
            SELECT
                id,
                product_key,
                display_name,
                product_label,
                category_slug
            FROM products_catalog
            WHERE id = ?
            LIMIT 1
            `,
            [giftProductId]
        );

        if (!giftProductRows.length) {
            return res.status(404).json({
                ok: false,
                error: "Товар-подарунок не знайдено в products_catalog"
            });
        }

        const giftProduct = giftProductRows[0];

        if (isStaffCertificateStock(giftProduct)) {
            return res.status(400).json({
                ok: false,
                error: "Сертифікат не можна обрати як подарунок"
            });
        }

        const requiredProducts = await getPersonalGiftProductsByIds(
            connection,
            requiredProductIds
        );

        if (requiredProductIds) {
            const expectedCount = String(requiredProductIds)
                .split(",")
                .filter(Boolean)
                .length;

            if (requiredProducts.length !== expectedCount) {
                return res.status(404).json({
                    ok: false,
                    error: "Один або декілька товарів для подарунку не знайдені в products_catalog"
                });
            }

            const hasCertificateRequiredProduct = requiredProducts.some(product =>
                isStaffCertificateStock(product)
            );

            if (hasCertificateRequiredProduct) {
                return res.status(400).json({
                    ok: false,
                    error: "Сертифікати не можна використовувати як умову для подарунку"
                });
            }
        }

        const giftProductTitle = getPersonalGiftProductDisplayName(giftProduct);

        const requiredTargetForDb = requiredProductIds
            ? `products:${requiredProductIds}`
            : requiredCategorySlug;

        const conditionText = requiredProductIds
            ? "за купівлю товарів: " + requiredProducts
                .map(product => getPersonalGiftProductDisplayName(product))
                .filter(Boolean)
                .join(", ")
            : "за купівлю товарів з категорій: " + requiredCategorySlug;

        const offerText = `Подарунок: ${giftProductTitle}. Умова: ${conditionText}.`;

        await connection.beginTransaction();

        let savedOfferId = offerId;

        if (offerId) {
            const [existingRows] = await connection.query(
                `
                SELECT
                    id
                FROM personal_offers
                WHERE id = ?
                  AND offer_type = 'gift'
                LIMIT 1
                `,
                [offerId]
            );

            if (!existingRows.length) {
                await connection.rollback();

                return res.status(404).json({
                    ok: false,
                    error: "Персональний подарунок не знайдено"
                });
            }

            await connection.query(
                `
                UPDATE personal_offers
                SET
                    title = ?,
                    offer_text = ?,
                    offer_type = 'gift',
                    promo_code = NULL,
                    discount_percent = NULL,
                    discount_amount = NULL,
                    min_order_amount = NULL,
                    required_category_slug = ?,
                    required_discount_level = ?,
                    required_customer_status = ?,
                    is_active = ?,
                    starts_at = ?,
                    ends_at = ?
                WHERE id = ?
                  AND offer_type = 'gift'
                `,
                [
                    title,
                    offerText,
                    requiredTargetForDb,
                    giftProductId,
                    requiredCustomerStatus,
                    isActive,
                    startsAt,
                    endsAt,
                    offerId
                ]
            );

        } else {
            const [result] = await connection.query(
                `
                INSERT INTO personal_offers
                (
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
                    is_active,
                    starts_at,
                    ends_at,
                    created_at
                )
                VALUES (?, ?, 'gift', NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, NOW())
                `,
                [
                    title,
                    offerText,
                    requiredTargetForDb,
                    giftProductId,
                    requiredCustomerStatus,
                    isActive,
                    startsAt,
                    endsAt
                ]
            );

            savedOfferId = result.insertId;
        }

        await connection.commit();

        return res.json({
            ok: true,
            offerId: savedOfferId,
            message: offerId
                ? "Персональний подарунок оновлено"
                : "Персональний подарунок створено"
        });

    } catch (err) {
        await connection.rollback();

        console.error("SAVE PERSONAL GIFT OFFER ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });

    } finally {
        connection.release();
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

/* ===================== STAFF: USERS MANAGEMENT ===================== */

async function getAdminStaffOrDeny(staffId) {
    const [staffRows] = await db.query(
        `
        SELECT
            id,
            role,
            is_active,
            can_manage_staff_users
        FROM staff_users
        WHERE id = ?
          AND is_active = 1
        LIMIT 1
        `,
        [staffId]
    );

    if (!staffRows.length) {
        return {
            ok: false,
            status: 403,
            error: "staff access denied"
        };
    }

    const staff = staffRows[0];

    if (staff.role !== "admin") {
        return {
            ok: false,
            status: 403,
            error: "admin only"
        };
    }

    return {
        ok: true,
        staff
    };
}

async function getStaffUsersManagerOrDeny(staffId) {
    const adminCheck = await getAdminStaffOrDeny(staffId);

    if (!adminCheck.ok) {
        return adminCheck;
    }

    if (Number(adminCheck.staff.can_manage_staff_users) !== 1) {
        return {
            ok: false,
            status: 403,
            error: "Немає права редагувати Staff users"
        };
    }

    return adminCheck;
}

/* ===================== STAFF: PRODUCTS ADMIN HELPERS ===================== */

async function getStaffAdminToolsManagerOrDeny(staffId) {
    return getStaffUsersManagerOrDeny(staffId);
}

function normalizeStaffProductName(value) {
    return String(value || "")
        .trim()
        .replace(/\s+/g, " ");
}

function normalizeStaffProductCapacityMl(value) {
    const capacity = Number(value || 0);

    if (!Number.isInteger(capacity) || capacity <= 0) {
        return 0;
    }

    return capacity;
}

function normalizeStaffProductPrice(value) {
    const price = Number(value || 0);

    if (!Number.isFinite(price) || price < 0) {
        return 0;
    }

    return Math.round(price);
}

function slugifyStaffProductPart(value) {
    const dictionary = {
        "а": "a", "б": "b", "в": "v", "г": "h", "ґ": "g", "д": "d",
        "е": "e", "є": "ye", "ж": "zh", "з": "z", "и": "y", "і": "i",
        "ї": "yi", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n",
        "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
        "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh",
        "щ": "shch", "ь": "", "ю": "yu", "я": "ya"
    };

    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[’ʼ']/g, "")
        .split("")
        .map(char => dictionary[char] !== undefined ? dictionary[char] : char)
        .join("")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function buildStaffProductKey({ categorySlug, productName, capacityMl }) {
    const category = slugifyStaffProductPart(categorySlug);
    const name = slugifyStaffProductPart(productName);
    const capacity = normalizeStaffProductCapacityMl(capacityMl);

    return [
        category,
        name,
        capacity ? `${capacity}ml` : ""
    ]
        .filter(Boolean)
        .join("_");
}

function buildStaffProductDisplayName({ productLabel, productName, capacityMl }) {
    const label = normalizeStaffProductName(productLabel);
    const name = normalizeStaffProductName(productName);
    const capacity = normalizeStaffProductCapacityMl(capacityMl);

    return [
        label,
        name,
        capacity ? `${capacity} ml` : ""
    ]
        .filter(Boolean)
        .join(" - ")
        .replace(/\s+-\s+(\d+\s+ml)$/i, " $1");
}

function isStaffCatalogProductStockManaged(product) {
    return (
        !isStaffCertificateStock(product) &&
        !isStaffDiscoveryProduct(product)
    );
}

function normalizeStaffUserRole(roleRaw) {
    const role = String(roleRaw || "").trim().toLowerCase();

    return ["admin", "manager", "partner"].includes(role)
        ? role
        : null;
}

function parseStaffUserLogin(loginRaw) {
    const login = String(loginRaw || "").trim();

    if (!login) {
        return {
            email: null,
            phone: null,
            error: "Вкажіть email або телефон"
        };
    }

    if (login.includes("@")) {
        const email = normalizeCustomerEmail(login);

        if (!email) {
            return {
                email: null,
                phone: null,
                error: "Некоректний email"
            };
        }

        return {
            email,
            phone: null,
            error: null
        };
    }

    const phone = normalizeCustomerPhone(login);

    if (!phone) {
        return {
            email: null,
            phone: null,
            error: "Некоректний номер телефону"
        };
    }

    return {
        email: null,
        phone,
        error: null
    };
}

async function ensureStaffLoginIsUnique({ email, phone, excludeStaffId = 0 }) {
    if (email) {
        const [rows] = await db.query(
            `
            SELECT id
            FROM staff_users
            WHERE LOWER(COALESCE(email, '')) = ?
              AND id <> ?
            LIMIT 1
            `,
            [email, excludeStaffId]
        );

        if (rows.length) {
            return "Цей email вже використовується staff-користувачем";
        }
    }

    if (phone) {
        const [rows] = await db.query(
            `
            SELECT id
            FROM staff_users
            WHERE phone = ?
              AND id <> ?
            LIMIT 1
            `,
            [phone, excludeStaffId]
        );

        if (rows.length) {
            return "Цей телефон вже використовується staff-користувачем";
        }
    }

    return null;
}

app.post("/api/staff/users-list", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);

        if (!staffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const adminCheck = await getAdminStaffOrDeny(staffId);

        if (!adminCheck.ok) {
            return res.status(adminCheck.status).json({
                ok: false,
                error: adminCheck.error
            });
        }

        const [users] = await db.query(
            `
            SELECT
                su.id,
                su.name,
                su.email,
                su.phone,
                su.role,
                su.warehouse_id,
                su.is_active,
                (
                    SELECT MAX(sb.warehouse_name)
                    FROM stock_balances sb
                    WHERE sb.warehouse_id = su.warehouse_id
                ) AS warehouse_name
            FROM staff_users su
            ORDER BY su.is_active DESC, su.role ASC, su.name ASC, su.id ASC
            `
        );

        return res.json({
            ok: true,
            users: users.map(user => ({
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                role: user.role,
                warehouse_id: user.warehouse_id,
                warehouse_name: user.warehouse_name,
                is_active: Number(user.is_active) === 1
            }))
        });

    } catch (err) {
        console.error("STAFF USERS LIST ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

app.post("/api/staff/users-create", async (req, res) => {
    try {
        const adminStaffId = Number(req.body.staffId || 0);
        const name = String(req.body.name || "").trim();
        const login = String(req.body.login || "").trim();
        const password = String(req.body.password || "").trim();
        const role = normalizeStaffUserRole(req.body.role);
        const warehouseIdRaw = req.body.warehouseId;
        const warehouseId = warehouseIdRaw === null || warehouseIdRaw === undefined || warehouseIdRaw === ""
            ? null
            : Number(warehouseIdRaw);

        if (!adminStaffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const adminCheck = await getStaffUsersManagerOrDeny(adminStaffId);

        if (!adminCheck.ok) {
            return res.status(adminCheck.status).json({
                ok: false,
                error: adminCheck.error
            });
        }

        if (!name || !password || !role) {
            return res.status(400).json({
                ok: false,
                error: "Вкажіть імʼя, пароль і роль"
            });
        }

        if (warehouseIdRaw !== null && warehouseIdRaw !== undefined && warehouseIdRaw !== "" && !warehouseId) {
            return res.status(400).json({
                ok: false,
                error: "Некоректний склад"
            });
        }

        const parsedLogin = parseStaffUserLogin(login);

        if (parsedLogin.error) {
            return res.status(400).json({
                ok: false,
                error: parsedLogin.error
            });
        }

        const uniqueError = await ensureStaffLoginIsUnique({
            email: parsedLogin.email,
            phone: parsedLogin.phone
        });

        if (uniqueError) {
            return res.status(400).json({
                ok: false,
                error: uniqueError
            });
        }

        if (warehouseId) {
            const [warehouseRows] = await db.query(
                `
                SELECT warehouse_id
                FROM stock_balances
                WHERE warehouse_id = ?
                LIMIT 1
                `,
                [warehouseId]
            );

            if (!warehouseRows.length) {
                return res.status(400).json({
                    ok: false,
                    error: "Склад не знайдено"
                });
            }
        }

        const hash = await bcrypt.hash(password, 10);

        const [result] = await db.query(
            `
            INSERT INTO staff_users
            (
                name,
                email,
                phone,
                password_hash,
                role,
                warehouse_id,
                is_active
            )
            VALUES (?, ?, ?, ?, ?, ?, 1)
            `,
            [
                name,
                parsedLogin.email,
                parsedLogin.phone,
                hash,
                role,
                warehouseId
            ]
        );

        return res.json({
            ok: true,
            user: {
                id: result.insertId,
                name,
                email: parsedLogin.email,
                phone: parsedLogin.phone,
                role,
                warehouse_id: warehouseId,
                is_active: true
            }
        });

    } catch (err) {
        console.error("STAFF USERS CREATE ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

app.post("/api/staff/users-update", async (req, res) => {
    try {
        const adminStaffId = Number(req.body.staffId || 0);
        const targetStaffId = Number(req.body.targetStaffId || 0);
        const name = String(req.body.name || "").trim();
        const role = normalizeStaffUserRole(req.body.role);
        const password = String(req.body.password || req.body.newPassword || "").trim();

        const warehouseIdRaw = req.body.warehouseId;
        const warehouseId = warehouseIdRaw === null || warehouseIdRaw === undefined || warehouseIdRaw === ""
            ? null
            : Number(warehouseIdRaw);

        const isActive = Number(req.body.isActive) === 1 ? 1 : 0;

        let email = null;
        let phone = null;

        const hasSeparateContacts =
            req.body.email !== undefined ||
            req.body.phone !== undefined;

        if (hasSeparateContacts) {
            email = normalizeCustomerEmail(req.body.email);

            if (req.body.phone !== undefined && String(req.body.phone || "").trim()) {
                phone = normalizeCustomerPhone(req.body.phone);

                if (!phone) {
                    return res.status(400).json({
                        ok: false,
                        error: "Некоректний номер телефону"
                    });
                }
            }
        } else {
            const parsedLogin = parseStaffUserLogin(req.body.login);

            if (parsedLogin.error) {
                return res.status(400).json({
                    ok: false,
                    error: parsedLogin.error
                });
            }

            email = parsedLogin.email;
            phone = parsedLogin.phone;
        }

        if (!adminStaffId || !targetStaffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staff ids"
            });
        }

        const adminCheck = await getStaffUsersManagerOrDeny(adminStaffId);

        if (!adminCheck.ok) {
            return res.status(adminCheck.status).json({
                ok: false,
                error: adminCheck.error
            });
        }

        if (!name || !role) {
            return res.status(400).json({
                ok: false,
                error: "Вкажіть імʼя і роль"
            });
        }

        if (!email && !phone) {
            return res.status(400).json({
                ok: false,
                error: "Вкажіть email або телефон"
            });
        }

        if (adminStaffId === targetStaffId && (role !== "admin" || isActive !== 1)) {
            return res.status(400).json({
                ok: false,
                error: "Не можна зняти адмін-доступ або деактивувати свій акаунт"
            });
        }

        if (warehouseIdRaw !== null && warehouseIdRaw !== undefined && warehouseIdRaw !== "" && !warehouseId) {
            return res.status(400).json({
                ok: false,
                error: "Некоректний склад"
            });
        }

        if (warehouseId) {
            const [warehouseRows] = await db.query(
                `
                SELECT warehouse_id
                FROM stock_balances
                WHERE warehouse_id = ?
                LIMIT 1
                `,
                [warehouseId]
            );

            if (!warehouseRows.length) {
                return res.status(400).json({
                    ok: false,
                    error: "Склад не знайдено"
                });
            }
        }

        const [existingRows] = await db.query(
            `
            SELECT
                id,
                name,
                email,
                phone,
                role,
                warehouse_id,
                is_active
            FROM staff_users
            WHERE id = ?
            LIMIT 1
            `,
            [targetStaffId]
        );

        if (!existingRows.length) {
            return res.status(404).json({
                ok: false,
                error: "Staff user не знайдений"
            });
        }

        const uniqueError = await ensureStaffLoginIsUnique({
            email,
            phone,
            excludeStaffId: targetStaffId
        });

        if (uniqueError) {
            return res.status(400).json({
                ok: false,
                error: uniqueError
            });
        }

        const updateFields = [
            "name = ?",
            "email = ?",
            "phone = ?",
            "role = ?",
            "warehouse_id = ?",
            "is_active = ?"
        ];

        const updateValues = [
            name,
            email,
            phone,
            role,
            warehouseId,
            isActive
        ];

        if (password) {
            const hash = await bcrypt.hash(password, 10);

            updateFields.push("password_hash = ?");
            updateValues.push(hash);
        }

        updateValues.push(targetStaffId);

        await db.query(
            `
            UPDATE staff_users
            SET
                ${updateFields.join(",\n                ")}
            WHERE id = ?
            `,
            updateValues
        );

        return res.json({
            ok: true,
            user: {
                id: targetStaffId,
                name,
                email,
                phone,
                role,
                warehouse_id: warehouseId,
                is_active: isActive === 1
            }
        });

    } catch (err) {
        console.error("STAFF USERS UPDATE ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

/* ===================== STAFF: FOCUS PROMO CAMPAIGNS ===================== */

function clearPublicPromoCampaignsCache() {
    PUBLIC_PROMO_CAMPAIGNS_CACHE = {
        expiresAt: 0,
        campaigns: []
    };
}

async function deactivateExpiredPromos(connection = db) {
    const [campaignResult] = await connection.query(
        `
        UPDATE promo_campaigns
        SET is_active = 0
        WHERE is_active = 1
          AND ends_at IS NOT NULL
          AND ends_at < NOW()
        `
    );

    const [personalResult] = await connection.query(
        `
        UPDATE personal_offers
        SET is_active = 0
        WHERE is_active = 1
          AND ends_at IS NOT NULL
          AND ends_at < NOW()
        `
    );

    if (Number(campaignResult?.affectedRows || 0) > 0) {
        clearPublicPromoCampaignsCache();
    }

    return {
        campaigns: Number(campaignResult?.affectedRows || 0),
        personalOffers: Number(personalResult?.affectedRows || 0)
    };
}

async function findFocusPromoConflicts({
    connection = db,
    promoId = 0,
    startsAt,
    endsAt
}) {
    const [conflicts] = await connection.query(
        `
        SELECT
            c.id,
            c.title,
            c.starts_at,
            c.ends_at,
            c.focus_product_id,
            p.display_name,
            p.product_name,
            p.product_label
        FROM promo_campaigns c
        LEFT JOIN products_catalog p
            ON p.id = c.focus_product_id
        WHERE c.promo_type = 'focus_product'
          AND c.audience = 'public'
          AND c.is_active = 1
          AND c.id <> ?
          AND COALESCE(c.starts_at, '1000-01-01 00:00:00') <= ?
          AND COALESCE(c.ends_at, '9999-12-31 23:59:59') >= ?
        ORDER BY c.starts_at ASC, c.id ASC
        `,
        [
            promoId,
            endsAt,
            startsAt
        ]
    );

    return conflicts;
}

app.post("/api/staff/focus-promos-list", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);

        if (!staffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const adminCheck = await getAdminStaffOrDeny(staffId);

        if (!adminCheck.ok) {
            return res.status(adminCheck.status).json({
                ok: false,
                error: adminCheck.error
            });
        }

        await deactivateExpiredPromos(db);

        const [campaigns] = await db.query(
            `
            SELECT
                c.id,
                c.title,
                c.promo_type,
                c.discount_percent,
                c.focus_product_id,
                DATE_FORMAT(c.starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
                DATE_FORMAT(c.ends_at, '%Y-%m-%d %H:%i:%s') AS ends_at,
                c.is_active,
                c.audience,
                c.exclude_certificates,
                c.exclude_from_personal_discount,
                c.combinable,
                c.target_apply_limit,
                c.target_selection,
                c.priority,
                c.created_at,

                p.product_key,
                p.product_name,
                p.product_label,
                p.category_slug,
                p.price,
                p.display_name
            FROM promo_campaigns c
            LEFT JOIN products_catalog p
                ON p.id = c.focus_product_id
            WHERE c.promo_type = 'focus_product'
              AND c.audience = 'public'
            ORDER BY c.starts_at DESC, c.id DESC
            `
        );

        const campaignIds = campaigns
            .map(campaign => Number(campaign.id || 0))
            .filter(id => Number.isInteger(id) && id > 0);

        let campaignWarehouses = [];

        if (campaignIds.length) {
            const placeholders = campaignIds.map(() => "?").join(",");

            const [warehouseRows] = await db.query(
                `
                SELECT
                    pcw.promo_campaign_id,
                    pcw.warehouse_id,
                    COALESCE(
                        MAX(sb.warehouse_name),
                        CONCAT('Склад ID ', pcw.warehouse_id)
                    ) AS warehouse_name
                FROM promo_campaign_warehouses pcw
                LEFT JOIN stock_balances sb
                    ON sb.warehouse_id = pcw.warehouse_id
                WHERE pcw.promo_campaign_id IN (${placeholders})
                GROUP BY
                    pcw.promo_campaign_id,
                    pcw.warehouse_id
                ORDER BY
                    pcw.promo_campaign_id ASC,
                    pcw.warehouse_id ASC
                `,
                campaignIds
            );

            campaignWarehouses = warehouseRows;
        }

        const warehousesByCampaign = new Map();

        campaignWarehouses.forEach(row => {
            const promoId = Number(row.promo_campaign_id || 0);

            if (!warehousesByCampaign.has(promoId)) {
                warehousesByCampaign.set(promoId, []);
            }

            warehousesByCampaign.get(promoId).push({
                warehouse_id: Number(row.warehouse_id || 0),
                warehouse_name: row.warehouse_name || `Склад ID ${row.warehouse_id}`
            });
        });

        return res.json({
            ok: true,
            campaigns: campaigns.map(campaign => {
                const campaignWarehousesList =
                    warehousesByCampaign.get(Number(campaign.id || 0)) || [];

                return {
                    id: campaign.id,
                    title: campaign.title,
                    promo_type: campaign.promo_type,
                    discount_percent: Number(campaign.discount_percent || 0),
                    focus_product_id: campaign.focus_product_id,
                    starts_at: campaign.starts_at,
                    ends_at: campaign.ends_at,
                    is_active: Number(campaign.is_active) === 1,
                    audience: campaign.audience,
                    exclude_certificates: Number(campaign.exclude_certificates) === 1,
                    exclude_from_personal_discount: Number(campaign.exclude_from_personal_discount) === 1,
                    combinable: Number(campaign.combinable) === 1,
                    target_apply_limit: campaign.target_apply_limit,
                    target_selection: campaign.target_selection,
                    priority: campaign.priority,
                    created_at: campaign.created_at,
                    warehouse_ids: campaignWarehousesList.map(warehouse => warehouse.warehouse_id),
                    warehouses: campaignWarehousesList,
                    product: campaign.focus_product_id
                        ? {
                            id: campaign.focus_product_id,
                            product_key: campaign.product_key,
                            product_name: campaign.product_name,
                            product_label: campaign.product_label,
                            category_slug: campaign.category_slug,
                            price: campaign.price,
                            display_name: campaign.display_name
                        }
                        : null
                };
            })
        });

    } catch (err) {
        console.error("STAFF FOCUS PROMOS LIST ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

app.post("/api/staff/focus-promo-save", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const promoId = Number(req.body.promoId || 0);
        const title = String(req.body.title || "Аромат дня").trim();
        const productId = Number(req.body.productId || 0);
        const discountPercent = Number(req.body.discountPercent || 0);
        const startsAt = String(req.body.startsAt || "").trim();
        const endsAt = String(req.body.endsAt || "").trim();
        const isActive = Number(req.body.isActive) === 1 ? 1 : 0;
        const replaceConflicts = Boolean(req.body.replaceConflicts);
        const priority = Number(req.body.priority || 10);

        const warehouseIds = Array.isArray(req.body.warehouseIds)
            ? [
                ...new Set(
                    req.body.warehouseIds
                        .map(id => Number(id || 0))
                        .filter(id => Number.isInteger(id) && id > 0)
                )
            ]
            : [];

        if (!staffId) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const adminCheck = await getAdminStaffOrDeny(staffId);

        if (!adminCheck.ok) {
            connection.release();

            return res.status(adminCheck.status).json({
                ok: false,
                error: adminCheck.error
            });
        }

        if (!title || !productId || !discountPercent || !startsAt || !endsAt) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Вкажіть назву, товар, знижку, дату старту і дату завершення"
            });
        }

        if (discountPercent <= 0 || discountPercent >= 100) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Знижка має бути більше 0 і менше 100"
            });
        }

        const startsTime = new Date(startsAt).getTime();
        const endsTime = new Date(endsAt).getTime();

        if (!Number.isFinite(startsTime) || !Number.isFinite(endsTime) || startsTime >= endsTime) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Некоректний період дії промо-кампанії"
            });
        }

        const [productRows] = await connection.query(
            `
            SELECT
                id,
                product_key,
                display_name,
                product_name,
                product_label,
                category_slug,
                price,
                is_active
            FROM products_catalog
            WHERE id = ?
              AND is_active = 1
            LIMIT 1
            `,
            [productId]
        );

        if (!productRows.length) {
            connection.release();

            return res.status(404).json({
                ok: false,
                error: "Товар не знайдено в products_catalog або товар неактивний"
            });
        }

        if (promoId) {
            const [existingRows] = await connection.query(
                `
                SELECT id
                FROM promo_campaigns
                WHERE id = ?
                  AND promo_type = 'focus_product'
                  AND audience = 'public'
                LIMIT 1
                `,
                [promoId]
            );

            if (!existingRows.length) {
                connection.release();

                return res.status(404).json({
                    ok: false,
                    error: "Промо-кампанію Аромат дня не знайдено"
                });
            }
        }

        let conflicts = [];

        if (isActive === 1) {
            conflicts = await findFocusPromoConflicts({
                connection,
                promoId,
                startsAt,
                endsAt
            });

            if (conflicts.length && !replaceConflicts) {
                connection.release();

                return res.status(409).json({
                    ok: false,
                    code: "focus_promo_period_conflict",
                    error: "У цей період уже є активна промо-кампанія Аромат дня",
                    conflicts
                });
            }
        }

        await connection.beginTransaction();

        if (isActive === 1 && conflicts.length && replaceConflicts) {
            await connection.query(
                `
                UPDATE promo_campaigns
                SET is_active = 0
                WHERE promo_type = 'focus_product'
                  AND audience = 'public'
                  AND id <> ?
                  AND is_active = 1
                  AND COALESCE(starts_at, '1000-01-01 00:00:00') <= ?
                  AND COALESCE(ends_at, '9999-12-31 23:59:59') >= ?
                `,
                [
                    promoId,
                    endsAt,
                    startsAt
                ]
            );
        }

        let savedPromoId = promoId;

        if (promoId) {
            await connection.query(
                `
                UPDATE promo_campaigns
                SET
                    title = ?,
                    discount_percent = ?,
                    focus_product_id = ?,
                    starts_at = ?,
                    ends_at = ?,
                    is_active = ?,
                    audience = 'public',
                    exclude_certificates = 1,
                    exclude_from_personal_discount = 1,
                    combinable = 0,
                    target_apply_limit = NULL,
                    target_selection = 'cheapest',
                    priority = ?
                WHERE id = ?
                  AND promo_type = 'focus_product'
                `,
                [
                    title,
                    discountPercent,
                    productId,
                    startsAt,
                    endsAt,
                    isActive,
                    priority,
                    promoId
                ]
            );
        } else {
            const [result] = await connection.query(
                `
                INSERT INTO promo_campaigns
                (
                    title,
                    promo_type,
                    discount_percent,
                    focus_product_id,
                    starts_at,
                    ends_at,
                    is_active,
                    created_at,
                    audience,
                    exclude_certificates,
                    exclude_from_personal_discount,
                    combinable,
                    target_apply_limit,
                    target_selection,
                    priority
                )
                VALUES (?, 'focus_product', ?, ?, ?, ?, ?, NOW(), 'public', 1, 1, 0, NULL, 'cheapest', ?)
                `,
                [
                    title,
                    discountPercent,
                    productId,
                    startsAt,
                    endsAt,
                    isActive,
                    priority
                ]
            );

            savedPromoId = result.insertId;
        }

        await connection.query(
            `
            DELETE FROM promo_campaign_warehouses
            WHERE promo_campaign_id = ?
            `,
            [savedPromoId]
        );

        if (warehouseIds.length) {
            await connection.query(
                `
                INSERT INTO promo_campaign_warehouses
                (
                    promo_campaign_id,
                    warehouse_id
                )
                VALUES ?
                `,
                [
                    warehouseIds.map(warehouseId => [
                        savedPromoId,
                        warehouseId
                    ])
                ]
            );
        }

        await connection.commit();

        clearPublicPromoCampaignsCache();
        connection.release();

        return res.json({
            ok: true,
            promoId: savedPromoId,
            disabledConflicts: conflicts.map(conflict => conflict.id)
        });

    } catch (err) {
        try {
            await connection.rollback();
        } catch (rollbackErr) {
            console.error("STAFF FOCUS PROMO ROLLBACK ERROR:", rollbackErr);
        }

        connection.release();

        console.error("STAFF FOCUS PROMO SAVE ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

/* ===================== STAFF: PUBLIC PROMO CODE PROMOS ===================== */

function normalizePublicPromoCode(value) {
    return String(value || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");
}

function buildPublicPromoCodeTargetSelection(promoCode, discountAmount) {
    return `code:${normalizePublicPromoCode(promoCode)};amount:${Number(discountAmount || 0)}`;
}

function getPublicPromoCodeTargetData(targetSelection) {
    const rawValue = String(targetSelection || "").trim();

    const result = {
        promoCode: "",
        discountAmount: 0
    };

    rawValue.split(";").forEach(part => {
        const [rawKey, ...rawRest] = String(part || "").split(":");
        const key = String(rawKey || "").trim().toLowerCase();
        const value = rawRest.join(":").trim();

        if (key === "code") {
            result.promoCode = normalizePublicPromoCode(value);
        }

        if (key === "amount") {
            result.discountAmount = Number(value || 0);
        }
    });

    return result;
}

function calculateStaffPublicPromoCodeOption(campaign, saleRows) {
    const targetData = getPublicPromoCodeTargetData(campaign.target_selection);
    const promoCode = targetData.promoCode;
    const discountValue = Number(targetData.discountAmount || 0);
    const minOrderAmount = Number(campaign.target_apply_limit || 0);

    const eligibleTotal = saleRows
        .filter(row =>
            !row?.isCertificateProduct &&
            !isStaffCertificateStock(row?.stock)
        )
        .reduce((sum, row) => sum + Number(row.rowTotal || 0), 0);

    let available = true;
    let message = "";

    if (!promoCode) {
        available = false;
        message = "У промо не вказано код";
    } else if (eligibleTotal <= 0) {
        available = false;
        message = "Промокод не діє на сертифікати";
    } else if (minOrderAmount > 0 && eligibleTotal < minOrderAmount) {
        available = false;
        message = `Потрібна сума від ${minOrderAmount} грн без врахування сертифікатів`;
    } else if (discountValue <= 0) {
        available = false;
        message = "У промо не вказано суму знижки";
    }

    const discountAmount = available
        ? Math.min(eligibleTotal, discountValue)
        : 0;

    return {
        campaignId: Number(campaign.id || 0),
        id: Number(campaign.id || 0),
        title: campaign.title || "Загальний промокод",
        promoCode,
        minOrderAmount,
        discountValue,
        eligibleTotal,
        discountAmount,
        available,
        message,
        note: available && discountAmount > 0
            ? `${campaign.title || "Загальний промокод"} ${promoCode}: -${discountAmount} грн`
            : ""
    };
}

async function getStaffPublicPromoCodeOptions(connection, saleRows, warehouseId, customerId) {
    const normalizedWarehouseId = Number(warehouseId || 0);

    if (!normalizedWarehouseId) {
        return [];
    }

    if (await isStaffVipCustomer(connection, customerId)) {
        return [];
    }

    const [campaignRows] = await connection.query(
        `
        SELECT
            pc.id,
            pc.title,
            pc.target_apply_limit,
            pc.target_selection,
            pc.priority
        FROM promo_campaigns pc
        INNER JOIN promo_campaign_warehouses pcw
            ON pcw.promo_campaign_id = pc.id
           AND pcw.warehouse_id = ?
        WHERE pc.is_active = 1
          AND pc.audience = 'public'
          AND pc.promo_type = 'public_promo_code'
          AND (pc.starts_at IS NULL OR pc.starts_at <= NOW())
          AND (pc.ends_at IS NULL OR pc.ends_at >= NOW())
        ORDER BY pc.priority ASC, pc.id DESC
        LIMIT 20
        `,
        [normalizedWarehouseId]
    );

    return campaignRows
        .map(campaign => calculateStaffPublicPromoCodeOption(campaign, saleRows))
        .filter(option => option.campaignId > 0 && option.promoCode);
}

function getSelectedStaffPublicPromoCodeOption(options, selectedPublicPromoCodeId) {
    const selectedId = Number(selectedPublicPromoCodeId || 0);

    if (!selectedId) {
        return null;
    }

    return (Array.isArray(options) ? options : []).find(option =>
        Number(option.campaignId || 0) === selectedId
    ) || null;
}

app.post("/api/staff/public-promo-code-promos-list", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);

        if (!staffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const adminCheck = await getAdminStaffOrDeny(staffId);

        if (!adminCheck.ok) {
            return res.status(adminCheck.status).json({
                ok: false,
                error: adminCheck.error
            });
        }

        await deactivateExpiredPromos(db);

        const [campaigns] = await db.query(
            `
            SELECT
                c.id,
                c.title,
                c.promo_type,
                c.discount_percent,
                c.focus_product_id,
                DATE_FORMAT(c.starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
                DATE_FORMAT(c.ends_at, '%Y-%m-%d %H:%i:%s') AS ends_at,
                c.is_active,
                c.audience,
                c.exclude_certificates,
                c.exclude_from_personal_discount,
                c.combinable,
                c.target_apply_limit,
                c.target_selection,
                c.priority,
                c.created_at
            FROM promo_campaigns c
            WHERE c.promo_type = 'public_promo_code'
              AND c.audience = 'public'
            ORDER BY c.starts_at DESC, c.id DESC
            `
        );

        const campaignIds = campaigns
            .map(campaign => Number(campaign.id || 0))
            .filter(id => Number.isInteger(id) && id > 0);

        let campaignWarehouses = [];

        if (campaignIds.length) {
            const placeholders = campaignIds.map(() => "?").join(",");

            const [warehouseRows] = await db.query(
                `
                SELECT
                    pcw.promo_campaign_id,
                    pcw.warehouse_id,
                    COALESCE(
                        MAX(sb.warehouse_name),
                        CONCAT('Склад ID ', pcw.warehouse_id)
                    ) AS warehouse_name
                FROM promo_campaign_warehouses pcw
                LEFT JOIN stock_balances sb
                    ON sb.warehouse_id = pcw.warehouse_id
                WHERE pcw.promo_campaign_id IN (${placeholders})
                GROUP BY
                    pcw.promo_campaign_id,
                    pcw.warehouse_id
                ORDER BY
                    pcw.promo_campaign_id ASC,
                    pcw.warehouse_id ASC
                `,
                campaignIds
            );

            campaignWarehouses = warehouseRows;
        }

        const warehousesByCampaign = new Map();

        campaignWarehouses.forEach(row => {
            const promoId = Number(row.promo_campaign_id || 0);

            if (!warehousesByCampaign.has(promoId)) {
                warehousesByCampaign.set(promoId, []);
            }

            warehousesByCampaign.get(promoId).push({
                warehouse_id: Number(row.warehouse_id || 0),
                warehouse_name: row.warehouse_name || `Склад ID ${row.warehouse_id}`
            });
        });

        return res.json({
            ok: true,
            campaigns: campaigns.map(campaign => {
                const targetData = getPublicPromoCodeTargetData(campaign.target_selection);
                const campaignWarehousesList =
                    warehousesByCampaign.get(Number(campaign.id || 0)) || [];

                return {
                    id: campaign.id,
                    title: campaign.title,
                    promo_type: campaign.promo_type,
                    promo_code: targetData.promoCode,
                    discount_amount: Number(targetData.discountAmount || 0),
                    min_order_amount: Number(campaign.target_apply_limit || 0),
                    starts_at: campaign.starts_at,
                    ends_at: campaign.ends_at,
                    is_active: Number(campaign.is_active) === 1,
                    audience: campaign.audience,
                    exclude_certificates: Number(campaign.exclude_certificates) === 1,
                    exclude_from_personal_discount: Number(campaign.exclude_from_personal_discount) === 1,
                    combinable: Number(campaign.combinable) === 1,
                    target_apply_limit: campaign.target_apply_limit,
                    target_selection: campaign.target_selection,
                    priority: campaign.priority,
                    created_at: campaign.created_at,
                    warehouse_ids: campaignWarehousesList.map(warehouse => warehouse.warehouse_id),
                    warehouses: campaignWarehousesList
                };
            })
        });

    } catch (err) {
        console.error("STAFF PUBLIC PROMO CODE PROMOS LIST ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

app.post("/api/staff/public-promo-code-promo-save", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const promoId = Number(req.body.promoId || 0);

        const title = String(req.body.title || "").trim();
        const promoCode = normalizePublicPromoCode(req.body.promoCode);
        const discountAmount = Number(req.body.discountAmount || 0);
        const minOrderAmount = Number(req.body.minOrderAmount || 0);
        const startsAt = String(req.body.startsAt || "").trim() || null;
        const endsAt = String(req.body.endsAt || "").trim() || null;
        const isActive = Number(req.body.isActive) === 1 ? 1 : 0;

        const warehouseIds = normalizePublicPercentPromoProductIds(
            req.body.warehouseIds
        );

        if (!staffId) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const adminCheck = await getAdminStaffOrDeny(staffId);

        if (!adminCheck.ok) {
            connection.release();

            return res.status(adminCheck.status).json({
                ok: false,
                error: adminCheck.error
            });
        }

        if (!title) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Вкажіть назву загального промокоду"
            });
        }

        if (!promoCode) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Вкажіть промокод"
            });
        }

        if (!discountAmount || discountAmount <= 0) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Вкажіть суму знижки більше 0 грн"
            });
        }

        if (minOrderAmount < 0) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Мінімальна сума чека не може бути меншою 0"
            });
        }

        if (!startsAt || !endsAt) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Вкажіть дату початку і дату завершення"
            });
        }

        if (!warehouseIds.length) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Оберіть хоча б один staff-склад"
            });
        }

        if (promoId) {
            const [existingRows] = await connection.query(
                `
                SELECT id
                FROM promo_campaigns
                WHERE id = ?
                  AND promo_type = 'public_promo_code'
                LIMIT 1
                `,
                [promoId]
            );

            if (!existingRows.length) {
                connection.release();

                return res.status(404).json({
                    ok: false,
                    error: "Загальний промокод не знайдено"
                });
            }
        }

        const targetSelection = buildPublicPromoCodeTargetSelection(
            promoCode,
            discountAmount
        );

        const priority = 15;

        await connection.beginTransaction();

        let savedPromoId = promoId;

        if (promoId) {
            await connection.query(
                `
                UPDATE promo_campaigns
                SET
                    title = ?,
                    discount_percent = 0,
                    focus_product_id = NULL,
                    starts_at = ?,
                    ends_at = ?,
                    is_active = ?,
                    audience = 'public',
                    exclude_certificates = 1,
                    exclude_from_personal_discount = 1,
                    combinable = 0,
                    target_apply_limit = ?,
                    target_selection = ?,
                    priority = ?
                WHERE id = ?
                  AND promo_type = 'public_promo_code'
                `,
                [
                    title,
                    startsAt,
                    endsAt,
                    isActive,
                    minOrderAmount,
                    targetSelection,
                    priority,
                    promoId
                ]
            );
        } else {
            const [result] = await connection.query(
                `
                INSERT INTO promo_campaigns
                (
                    title,
                    promo_type,
                    discount_percent,
                    focus_product_id,
                    starts_at,
                    ends_at,
                    is_active,
                    created_at,
                    audience,
                    exclude_certificates,
                    exclude_from_personal_discount,
                    combinable,
                    target_apply_limit,
                    target_selection,
                    priority
                )
                VALUES (?, 'public_promo_code', 0, NULL, ?, ?, ?, NOW(), 'public', 1, 1, 0, ?, ?, ?)
                `,
                [
                    title,
                    startsAt,
                    endsAt,
                    isActive,
                    minOrderAmount,
                    targetSelection,
                    priority
                ]
            );

            savedPromoId = result.insertId;
        }

        await connection.query(
            `
            DELETE FROM promo_campaign_warehouses
            WHERE promo_campaign_id = ?
            `,
            [savedPromoId]
        );

        await connection.query(
            `
            INSERT INTO promo_campaign_warehouses
            (
                promo_campaign_id,
                warehouse_id
            )
            VALUES ?
            `,
            [
                warehouseIds.map(warehouseId => [
                    savedPromoId,
                    warehouseId
                ])
            ]
        );

        await connection.commit();

        clearPublicPromoCampaignsCache();
        connection.release();

        return res.json({
            ok: true,
            promoId: savedPromoId,
            promoCode,
            discountAmount,
            minOrderAmount
        });

    } catch (err) {
        try {
            await connection.rollback();
        } catch (rollbackErr) {
            console.error("STAFF PUBLIC PROMO CODE ROLLBACK ERROR:", rollbackErr);
        }

        connection.release();

        console.error("STAFF PUBLIC PROMO CODE SAVE ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

/* ===================== STAFF: PUBLIC PERCENT PROMOS LIST ===================== */

app.post("/api/staff/public-percent-promos-list", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);

        if (!staffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const adminCheck = await getAdminStaffOrDeny(staffId);

        if (!adminCheck.ok) {
            return res.status(adminCheck.status).json({
                ok: false,
                error: adminCheck.error
            });
        }

        await deactivateExpiredPromos(db);

        const [campaigns] = await db.query(
            `
            SELECT
                c.id,
                c.title,
                c.promo_type,
                c.discount_percent,
                c.focus_product_id,
                DATE_FORMAT(c.starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
                DATE_FORMAT(c.ends_at, '%Y-%m-%d %H:%i:%s') AS ends_at,
                c.is_active,
                c.audience,
                c.exclude_certificates,
                c.exclude_from_personal_discount,
                c.combinable,
                c.target_apply_limit,
                c.target_selection,
                c.priority,
                c.created_at
            FROM promo_campaigns c
            WHERE c.promo_type = 'public_percent'
              AND c.audience = 'public'
            ORDER BY c.starts_at DESC, c.id DESC
            `
        );

        const campaignIds = campaigns
            .map(campaign => Number(campaign.id || 0))
            .filter(id => Number.isInteger(id) && id > 0);

        let campaignWarehouses = [];

        if (campaignIds.length) {
            const placeholders = campaignIds.map(() => "?").join(",");

            const [warehouseRows] = await db.query(
                `
                SELECT
                    pcw.promo_campaign_id,
                    pcw.warehouse_id,
                    COALESCE(
                        MAX(sb.warehouse_name),
                        CONCAT('Склад ID ', pcw.warehouse_id)
                    ) AS warehouse_name
                FROM promo_campaign_warehouses pcw
                LEFT JOIN stock_balances sb
                    ON sb.warehouse_id = pcw.warehouse_id
                WHERE pcw.promo_campaign_id IN (${placeholders})
                GROUP BY
                    pcw.promo_campaign_id,
                    pcw.warehouse_id
                ORDER BY
                    pcw.promo_campaign_id ASC,
                    pcw.warehouse_id ASC
                `,
                campaignIds
            );

            campaignWarehouses = warehouseRows;
        }

        const warehousesByCampaign = new Map();

        campaignWarehouses.forEach(row => {
            const promoId = Number(row.promo_campaign_id || 0);

            if (!warehousesByCampaign.has(promoId)) {
                warehousesByCampaign.set(promoId, []);
            }

            warehousesByCampaign.get(promoId).push({
                warehouse_id: Number(row.warehouse_id || 0),
                warehouse_name: row.warehouse_name || `Склад ID ${row.warehouse_id}`
            });
        });

        return res.json({
            ok: true,
            campaigns: campaigns.map(campaign => {
                const campaignWarehousesList =
                    warehousesByCampaign.get(Number(campaign.id || 0)) || [];

                return {
                    id: campaign.id,
                    title: campaign.title,
                    promo_type: campaign.promo_type,
                    discount_percent: Number(campaign.discount_percent || 0),
                    focus_product_id: campaign.focus_product_id,
                    starts_at: campaign.starts_at,
                    ends_at: campaign.ends_at,
                    is_active: Number(campaign.is_active) === 1,
                    audience: campaign.audience,
                    exclude_certificates: Number(campaign.exclude_certificates) === 1,
                    exclude_from_personal_discount: Number(campaign.exclude_from_personal_discount) === 1,
                    combinable: Number(campaign.combinable) === 1,
                    target_apply_limit: campaign.target_apply_limit,
                    target_selection: campaign.target_selection,
                    priority: campaign.priority,
                    created_at: campaign.created_at,
                    warehouse_ids: campaignWarehousesList.map(warehouse => warehouse.warehouse_id),
                    warehouses: campaignWarehousesList
                };
            })
        });

    } catch (err) {
        console.error("STAFF PUBLIC PERCENT PROMOS LIST ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

/* ===================== STAFF: PUBLIC PERCENT PROMO SAVE ===================== */

function normalizePublicPercentPromoCategorySlugs(values) {
    if (!Array.isArray(values)) return [];

    return [
        ...new Set(
            values
                .map(value => String(value || "").trim().toLowerCase())
                .filter(Boolean)
                .filter(value => value !== "certificates")
        )
    ];
}

function normalizePublicPercentPromoProductIds(values) {
    if (!Array.isArray(values)) return [];

    return [
        ...new Set(
            values
                .map(value => Number(value || 0))
                .filter(id => Number.isInteger(id) && id > 0)
        )
    ];
}

function buildPublicPercentPromoTargetSelection(categorySlugs, productIds) {
    if (productIds.length) {
        return `products:${productIds.join(",")}`;
    }

    if (
        !categorySlugs.length ||
        categorySlugs.includes("all")
    ) {
        return "all";
    }

    return `categories:${categorySlugs.join(",")}`;
}

app.post("/api/staff/public-percent-promo-save", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const promoId = Number(req.body.promoId || 0);

        const title = String(req.body.title || "").trim();
        const discountPercent = Number(req.body.discountPercent || 0);
        const startsAt = String(req.body.startsAt || "").trim() || null;
        const endsAt = String(req.body.endsAt || "").trim() || null;
        const isActive = Number(req.body.isActive) === 1 ? 1 : 0;

        const categorySlugs = normalizePublicPercentPromoCategorySlugs(
            req.body.categorySlugs
        );

        const productIds = normalizePublicPercentPromoProductIds(
            req.body.productIds
        );

        const warehouseIds = normalizePublicPercentPromoProductIds(
            req.body.warehouseIds
        );

        if (!staffId) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const adminCheck = await getAdminStaffOrDeny(staffId);

        if (!adminCheck.ok) {
            connection.release();

            return res.status(adminCheck.status).json({
                ok: false,
                error: adminCheck.error
            });
        }

        if (!title) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Вкажіть назву загальної % знижки"
            });
        }

        if (!discountPercent || discountPercent <= 0 || discountPercent >= 100) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Вкажіть знижку більше 0 і менше 100"
            });
        }

        if (!startsAt || !endsAt) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Вкажіть дату початку і дату завершення"
            });
        }

        if (!warehouseIds.length) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Оберіть хоча б один staff-склад"
            });
        }

        if (productIds.length) {
            const productPlaceholders = productIds.map(() => "?").join(",");

            const [allowedProducts] = await connection.query(
                `
                SELECT id
                FROM products_catalog
                WHERE id IN (${productPlaceholders})
                  AND is_active = 1
                  AND NOT (
                        LOWER(TRIM(COALESCE(product_key, ''))) LIKE 'certificate_%'
                        OR LOWER(TRIM(COALESCE(display_name, ''))) LIKE '%сертифікат%'
                        OR LOWER(TRIM(COALESCE(product_label, ''))) LIKE '%сертифікат%'
                        OR LOWER(TRIM(COALESCE(category_slug, ''))) = 'certificates'
                  )
                `,
                productIds
            );

            if (allowedProducts.length !== productIds.length) {
                connection.release();

                return res.status(400).json({
                    ok: false,
                    error: "У загальну % знижку не можна додавати неактивні товари або сертифікати"
                });
            }
        }

        if (promoId) {
            const [existingRows] = await connection.query(
                `
                SELECT id
                FROM promo_campaigns
                WHERE id = ?
                  AND promo_type = 'public_percent'
                LIMIT 1
                `,
                [promoId]
            );

            if (!existingRows.length) {
                connection.release();

                return res.status(404).json({
                    ok: false,
                    error: "Загальну % знижку не знайдено"
                });
            }
        }

        const targetSelection = buildPublicPercentPromoTargetSelection(
            categorySlugs,
            productIds
        );

        const priority = 20;

        await connection.beginTransaction();

        let savedPromoId = promoId;

        if (promoId) {
            await connection.query(
                `
                UPDATE promo_campaigns
                SET
                    title = ?,
                    discount_percent = ?,
                    focus_product_id = NULL,
                    starts_at = ?,
                    ends_at = ?,
                    is_active = ?,
                    audience = 'public',
                    exclude_certificates = 1,
                    exclude_from_personal_discount = 1,
                    combinable = 0,
                    target_apply_limit = NULL,
                    target_selection = ?,
                    priority = ?
                WHERE id = ?
                  AND promo_type = 'public_percent'
                `,
                [
                    title,
                    discountPercent,
                    startsAt,
                    endsAt,
                    isActive,
                    targetSelection,
                    priority,
                    promoId
                ]
            );
        } else {
            const [result] = await connection.query(
                `
                INSERT INTO promo_campaigns
                (
                    title,
                    promo_type,
                    discount_percent,
                    focus_product_id,
                    starts_at,
                    ends_at,
                    is_active,
                    created_at,
                    audience,
                    exclude_certificates,
                    exclude_from_personal_discount,
                    combinable,
                    target_apply_limit,
                    target_selection,
                    priority
                )
                VALUES (?, 'public_percent', ?, NULL, ?, ?, ?, NOW(), 'public', 1, 1, 0, NULL, ?, ?)
                `,
                [
                    title,
                    discountPercent,
                    startsAt,
                    endsAt,
                    isActive,
                    targetSelection,
                    priority
                ]
            );

            savedPromoId = result.insertId;
        }

        await connection.query(
            `
            DELETE FROM promo_campaign_warehouses
            WHERE promo_campaign_id = ?
            `,
            [savedPromoId]
        );

        await connection.query(
            `
            INSERT INTO promo_campaign_warehouses
            (
                promo_campaign_id,
                warehouse_id
            )
            VALUES ?
            `,
            [
                warehouseIds.map(warehouseId => [
                    savedPromoId,
                    warehouseId
                ])
            ]
        );

        await connection.commit();

        clearPublicPromoCampaignsCache();
        connection.release();

        return res.json({
            ok: true,
            promoId: savedPromoId,
            targetSelection
        });

    } catch (err) {
        try {
            await connection.rollback();
        } catch (rollbackErr) {
            console.error("STAFF PUBLIC PERCENT PROMO ROLLBACK ERROR:", rollbackErr);
        }

        connection.release();

        console.error("STAFF PUBLIC PERCENT PROMO SAVE ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

/* ===================== STAFF: PUBLIC GIFT PROMOS ===================== */

function isPublicGiftPromoCertificateOrConsumableWhereSql(alias = "p") {
    return `
        NOT (
            LOWER(TRIM(COALESCE(${alias}.product_key, ''))) LIKE 'certificate_%'
            OR LOWER(TRIM(COALESCE(${alias}.display_name, ''))) LIKE '%сертифікат%'
            OR LOWER(TRIM(COALESCE(${alias}.product_label, ''))) LIKE '%сертифікат%'
            OR LOWER(TRIM(COALESCE(${alias}.category_slug, ''))) = 'certificates'
            OR LOWER(TRIM(COALESCE(${alias}.category_slug, ''))) = 'consumables'
            OR LOWER(TRIM(COALESCE(${alias}.product_key, ''))) LIKE 'consumable_%'
            OR LOWER(TRIM(COALESCE(${alias}.display_name, ''))) LIKE '%розхідник%'
            OR LOWER(TRIM(COALESCE(${alias}.product_label, ''))) LIKE '%розхідник%'
            OR LOWER(TRIM(COALESCE(${alias}.product_name, ''))) LIKE '%розхідник%'
        )
    `;
}

app.post("/api/staff/public-gift-promos-list", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);

        if (!staffId) {
            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const adminCheck = await getAdminStaffOrDeny(staffId);

        if (!adminCheck.ok) {
            return res.status(adminCheck.status).json({
                ok: false,
                error: adminCheck.error
            });
        }

        await deactivateExpiredPromos(db);

        const [campaigns] = await db.query(
            `
            SELECT
                c.id,
                c.title,
                c.promo_type,
                c.discount_percent,
                c.focus_product_id,
                DATE_FORMAT(c.starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
                DATE_FORMAT(c.ends_at, '%Y-%m-%d %H:%i:%s') AS ends_at,
                c.is_active,
                c.audience,
                c.exclude_certificates,
                c.exclude_from_personal_discount,
                c.combinable,
                c.target_apply_limit,
                c.target_selection,
                c.priority,
                c.created_at,

                p.product_key AS gift_product_key,
                p.product_name AS gift_product_name,
                p.product_label AS gift_product_label,
                p.category_slug AS gift_category_slug,
                p.price AS gift_price,
                p.display_name AS gift_display_name
            FROM promo_campaigns c
            LEFT JOIN products_catalog p
                ON p.id = c.focus_product_id
            WHERE c.promo_type = 'public_gift'
              AND c.audience = 'public'
            ORDER BY c.starts_at DESC, c.id DESC
            `
        );

        const campaignIds = campaigns
            .map(campaign => Number(campaign.id || 0))
            .filter(id => Number.isInteger(id) && id > 0);

        let campaignWarehouses = [];

        if (campaignIds.length) {
            const placeholders = campaignIds.map(() => "?").join(",");

            const [warehouseRows] = await db.query(
                `
                SELECT
                    pcw.promo_campaign_id,
                    pcw.warehouse_id,
                    COALESCE(
                        MAX(sb.warehouse_name),
                        CONCAT('Склад ID ', pcw.warehouse_id)
                    ) AS warehouse_name
                FROM promo_campaign_warehouses pcw
                LEFT JOIN stock_balances sb
                    ON sb.warehouse_id = pcw.warehouse_id
                WHERE pcw.promo_campaign_id IN (${placeholders})
                GROUP BY
                    pcw.promo_campaign_id,
                    pcw.warehouse_id
                ORDER BY
                    pcw.promo_campaign_id ASC,
                    pcw.warehouse_id ASC
                `,
                campaignIds
            );

            campaignWarehouses = warehouseRows;
        }

        const warehousesByCampaign = new Map();

        campaignWarehouses.forEach(row => {
            const promoId = Number(row.promo_campaign_id || 0);

            if (!warehousesByCampaign.has(promoId)) {
                warehousesByCampaign.set(promoId, []);
            }

            warehousesByCampaign.get(promoId).push({
                warehouse_id: Number(row.warehouse_id || 0),
                warehouse_name: row.warehouse_name || `Склад ID ${row.warehouse_id}`
            });
        });

        return res.json({
            ok: true,
            campaigns: campaigns.map(campaign => {
                const campaignWarehousesList =
                    warehousesByCampaign.get(Number(campaign.id || 0)) || [];

                return {
                    id: campaign.id,
                    title: campaign.title,
                    promo_type: campaign.promo_type,
                    discount_percent: Number(campaign.discount_percent || 0),
                    focus_product_id: campaign.focus_product_id,
                    starts_at: campaign.starts_at,
                    ends_at: campaign.ends_at,
                    is_active: Number(campaign.is_active) === 1,
                    audience: campaign.audience,
                    exclude_certificates: Number(campaign.exclude_certificates) === 1,
                    exclude_from_personal_discount: Number(campaign.exclude_from_personal_discount) === 1,
                    combinable: Number(campaign.combinable) === 1,
                    target_apply_limit: campaign.target_apply_limit,
                    target_selection: campaign.target_selection,
                    priority: campaign.priority,
                    created_at: campaign.created_at,
                    gift_product: {
                        id: campaign.focus_product_id,
                        product_key: campaign.gift_product_key,
                        product_name: campaign.gift_product_name,
                        product_label: campaign.gift_product_label,
                        category_slug: campaign.gift_category_slug,
                        price: campaign.gift_price,
                        display_name: campaign.gift_display_name
                    },
                    warehouse_ids: campaignWarehousesList.map(warehouse => warehouse.warehouse_id),
                    warehouses: campaignWarehousesList
                };
            })
        });

    } catch (err) {
        console.error("STAFF PUBLIC GIFT PROMOS LIST ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

app.post("/api/staff/public-gift-promo-save", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const promoId = Number(req.body.promoId || 0);

        const title = String(req.body.title || "").trim();
        const giftProductId = Number(req.body.giftProductId || 0);
        const startsAt = String(req.body.startsAt || "").trim() || null;
        const endsAt = String(req.body.endsAt || "").trim() || null;
        const isActive = Number(req.body.isActive) === 1 ? 1 : 0;

        const categorySlugs = normalizePublicPercentPromoCategorySlugs(
            req.body.categorySlugs
        );

        const productIds = normalizePublicPercentPromoProductIds(
            req.body.productIds
        );

        const warehouseIds = normalizePublicPercentPromoProductIds(
            req.body.warehouseIds
        );

        if (!staffId) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "missing staffId"
            });
        }

        const adminCheck = await getAdminStaffOrDeny(staffId);

        if (!adminCheck.ok) {
            connection.release();

            return res.status(adminCheck.status).json({
                ok: false,
                error: adminCheck.error
            });
        }

        if (!title) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Вкажіть назву загального подарунку"
            });
        }

        if (!giftProductId) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Оберіть товар-подарунок"
            });
        }

        if (!startsAt || !endsAt) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Вкажіть дату початку і дату завершення"
            });
        }

        const startsTime = new Date(startsAt).getTime();
        const endsTime = new Date(endsAt).getTime();

        if (!Number.isFinite(startsTime) || !Number.isFinite(endsTime) || startsTime >= endsTime) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Некоректний період дії загального подарунку"
            });
        }

        if (!warehouseIds.length) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Оберіть хоча б один staff-склад"
            });
        }

        const [giftRows] = await connection.query(
            `
            SELECT id
            FROM products_catalog p
            WHERE p.id = ?
              AND p.is_active = 1
              AND ${isPublicGiftPromoCertificateOrConsumableWhereSql("p")}
            LIMIT 1
            `,
            [giftProductId]
        );

        if (!giftRows.length) {
            connection.release();

            return res.status(400).json({
                ok: false,
                error: "Подарунок не знайдено або цей товар не можна використовувати як подарунок"
            });
        }

        if (productIds.length) {
            const productPlaceholders = productIds.map(() => "?").join(",");

            const [allowedProducts] = await connection.query(
                `
                SELECT id
                FROM products_catalog p
                WHERE p.id IN (${productPlaceholders})
                  AND p.is_active = 1
                  AND ${isPublicGiftPromoCertificateOrConsumableWhereSql("p")}
                `,
                productIds
            );

            if (allowedProducts.length !== productIds.length) {
                connection.release();

                return res.status(400).json({
                    ok: false,
                    error: "В умову подарунку не можна додавати неактивні товари, сертифікати або розхідники"
                });
            }
        }

        if (promoId) {
            const [existingRows] = await connection.query(
                `
                SELECT id
                FROM promo_campaigns
                WHERE id = ?
                  AND promo_type = 'public_gift'
                LIMIT 1
                `,
                [promoId]
            );

            if (!existingRows.length) {
                connection.release();

                return res.status(404).json({
                    ok: false,
                    error: "Загальний подарунок не знайдено"
                });
            }
        }

        const targetSelection = buildPublicPercentPromoTargetSelection(
            categorySlugs,
            productIds
        );

        const priority = 30;

        await connection.beginTransaction();

        let savedPromoId = promoId;

        if (promoId) {
            await connection.query(
                `
                UPDATE promo_campaigns
                SET
                    title = ?,
                    discount_percent = 0,
                    focus_product_id = ?,
                    starts_at = ?,
                    ends_at = ?,
                    is_active = ?,
                    audience = 'public',
                    exclude_certificates = 1,
                    exclude_from_personal_discount = 1,
                    combinable = 0,
                    target_apply_limit = NULL,
                    target_selection = ?,
                    priority = ?
                WHERE id = ?
                  AND promo_type = 'public_gift'
                `,
                [
                    title,
                    giftProductId,
                    startsAt,
                    endsAt,
                    isActive,
                    targetSelection,
                    priority,
                    promoId
                ]
            );
        } else {
            const [result] = await connection.query(
                `
                INSERT INTO promo_campaigns
                (
                    title,
                    promo_type,
                    discount_percent,
                    focus_product_id,
                    starts_at,
                    ends_at,
                    is_active,
                    created_at,
                    audience,
                    exclude_certificates,
                    exclude_from_personal_discount,
                    combinable,
                    target_apply_limit,
                    target_selection,
                    priority
                )
                VALUES (?, 'public_gift', 0, ?, ?, ?, ?, NOW(), 'public', 1, 1, 0, NULL, ?, ?)
                `,
                [
                    title,
                    giftProductId,
                    startsAt,
                    endsAt,
                    isActive,
                    targetSelection,
                    priority
                ]
            );

            savedPromoId = result.insertId;
        }

        await connection.query(
            `
            DELETE FROM promo_campaign_warehouses
            WHERE promo_campaign_id = ?
            `,
            [savedPromoId]
        );

        await connection.query(
            `
            INSERT INTO promo_campaign_warehouses
            (
                promo_campaign_id,
                warehouse_id
            )
            VALUES ?
            `,
            [
                warehouseIds.map(warehouseId => [
                    savedPromoId,
                    warehouseId
                ])
            ]
        );

        await connection.commit();

        clearPublicPromoCampaignsCache();
        connection.release();

        return res.json({
            ok: true,
            promoId: savedPromoId,
            targetSelection
        });

    } catch (err) {
        try {
            await connection.rollback();
        } catch (rollbackErr) {
            console.error("STAFF PUBLIC GIFT PROMO ROLLBACK ERROR:", rollbackErr);
        }

        connection.release();

        console.error("STAFF PUBLIC GIFT PROMO SAVE ERROR:", err);

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
                product_name,
                display_name,
                product_label,
                capacity_ml,
                price,
                cost_price,
                realization_price,
                category_slug,
                is_active,
                staff_only
            FROM products_catalog
            WHERE is_active = 1
              AND LOWER(COALESCE(category_slug, '')) <> 'consumables'
              AND LOWER(COALESCE(product_key, '')) NOT LIKE 'consumable_%'
              AND LOWER(COALESCE(product_label, '')) NOT LIKE '%розхідник%'
              AND LOWER(COALESCE(product_name, '')) NOT LIKE '%розхідник%'
              AND LOWER(COALESCE(display_name, '')) NOT LIKE '%розхідник%'
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

/* ===================== STAFF: PRODUCTS ADMIN ===================== */

app.post("/api/staff/admin-product-categories", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);
        const access = await getStaffAdminToolsManagerOrDeny(staffId);

        if (!access.ok) {
            return res.status(access.status).json({
                ok: false,
                error: access.error
            });
        }

        const [products] = await db.query(
            `
            SELECT
                id,
                product_key,
                product_name,
                display_name,
                product_label,
                category_slug,
                capacity_ml,
                price,
                cost_price,
                realization_price,
                is_active,
                staff_only
            FROM products_catalog
            WHERE category_slug IS NOT NULL
              AND TRIM(category_slug) <> ''
            ORDER BY category_slug ASC, id ASC
            `
        );

        const categoriesMap = new Map();

        for (const product of products) {
            const categorySlug = String(product.category_slug || "").trim();
            if (!categorySlug) continue;

            if (!categoriesMap.has(categorySlug)) {
                categoriesMap.set(categorySlug, {
                    category_slug: categorySlug,
                    product_label: product.product_label || "",
                    sample: product
                });
            }
        }

        return res.json({
            ok: true,
            categories: Array.from(categoriesMap.values())
        });

    } catch (err) {
        console.error("STAFF ADMIN PRODUCT CATEGORIES ERROR:", err);
        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

app.post("/api/staff/admin-products-list", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);
        const categorySlug = String(req.body.categorySlug || "").trim();
        const status = String(req.body.status || "active").trim().toLowerCase();

        const access = await getStaffAdminToolsManagerOrDeny(staffId);

        if (!access.ok) {
            return res.status(access.status).json({
                ok: false,
                error: access.error
            });
        }

        const where = [];
        const values = [];

        if (categorySlug && categorySlug !== "all") {
            where.push("category_slug = ?");
            values.push(categorySlug);
        }

        if (status === "active") {
            where.push("is_active = 1");
        } else if (status === "inactive") {
            where.push("is_active = 0");
        }

        const whereSql = where.length
            ? "WHERE " + where.join(" AND ")
            : "";

        const [products] = await db.query(
            `
            SELECT
                id,
                product_key,
                product_name,
                display_name,
                product_label,
                category_slug,
                capacity_ml,
                price,
                cost_price,
                realization_price,
                is_active,
                staff_only
            FROM products_catalog
            ${whereSql}
            ORDER BY category_slug ASC, display_name ASC
            `,
            values
        );

        return res.json({
            ok: true,
            products
        });

    } catch (err) {
        console.error("STAFF ADMIN PRODUCTS LIST ERROR:", err);
        return res.status(500).json({
            ok: false,
            error: "server error"
        });
    }
});

app.post("/api/staff/admin-create-product", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const categorySlug = String(req.body.categorySlug || "").trim();
        const productName = normalizeStaffProductName(req.body.productName);
        const capacityMl = normalizeStaffProductCapacityMl(req.body.capacityMl);
        const price = normalizeStaffProductPrice(req.body.price);
        const costPrice = normalizeStaffProductPrice(req.body.costPrice);
        const realizationPrice = normalizeStaffProductPrice(req.body.realizationPrice);
        const isActive = Number(req.body.isActive) === 1 ? 1 : 0;

        const access = await getStaffAdminToolsManagerOrDeny(staffId);

        if (!access.ok) {
            return res.status(access.status).json({
                ok: false,
                error: access.error
            });
        }

        if (!categorySlug) {
            return res.status(400).json({
                ok: false,
                error: "Оберіть категорію"
            });
        }

        if (!productName) {
            return res.status(400).json({
                ok: false,
                error: "Вкажіть назву товару"
            });
        }

        if (!capacityMl) {
            return res.status(400).json({
                ok: false,
                error: "Вкажіть ємність цифрою"
            });
        }

        const [categoryRows] = await connection.query(
            `
            SELECT
                category_slug,
                product_label
            FROM products_catalog
            WHERE category_slug = ?
            ORDER BY id ASC
            LIMIT 1
            `,
            [categorySlug]
        );

        if (!categoryRows.length) {
            return res.status(400).json({
                ok: false,
                error: "Категорію не знайдено в products_catalog"
            });
        }

        const productLabel = String(categoryRows[0].product_label || "").trim();

        const productKey = buildStaffProductKey({
            categorySlug,
            productName,
            capacityMl
        });

        const displayName = buildStaffProductDisplayName({
            productLabel,
            productName,
            capacityMl
        });

        if (!productKey) {
            return res.status(400).json({
                ok: false,
                error: "Не вдалося сформувати product_key"
            });
        }

        const [existingRows] = await connection.query(
            `
            SELECT id
            FROM products_catalog
            WHERE product_key = ?
            LIMIT 1
            `,
            [productKey]
        );

        if (existingRows.length) {
            return res.status(400).json({
                ok: false,
                error: "Товар з таким product_key вже існує"
            });
        }

        await connection.beginTransaction();

        const [insertResult] = await connection.query(
            `
            INSERT INTO products_catalog
            (
                product_key,
                product_name,
                display_name,
                product_label,
                category_slug,
                capacity_ml,
                price,
                cost_price,
                realization_price,
                is_active,
                staff_only
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            `,
            [
                productKey,
                productName,
                displayName,
                productLabel,
                categorySlug,
                capacityMl,
                price,
                costPrice,
                realizationPrice,
                isActive
            ]
        );

        const productId = Number(insertResult.insertId || 0);

        const stockManaged = isStaffCatalogProductStockManaged({
            product_key: productKey,
            display_name: displayName,
            product_label: productLabel,
            category_slug: categorySlug
        });

        if (productId && stockManaged) {
            await connection.query(
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
                    w.warehouse_id,
                    w.warehouse_name,
                    w.supplier_details,
                    w.buyer_details,
                    w.document_basis,
                    w.act_city,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    0,
                    0
                FROM (
                    SELECT
                        warehouse_id,
                        MAX(warehouse_name) AS warehouse_name,
                        MAX(supplier_details) AS supplier_details,
                        MAX(buyer_details) AS buyer_details,
                        MAX(document_basis) AS document_basis,
                        MAX(act_city) AS act_city
                    FROM stock_balances
                    WHERE warehouse_id IS NOT NULL
                    GROUP BY warehouse_id
                ) w
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM stock_balances sb
                    WHERE sb.warehouse_id = w.warehouse_id
                      AND sb.product_id = ?
                )
                `,
                [
                    productId,
                    productKey,
                    displayName,
                    price,
                    costPrice,
                    realizationPrice,
                    productId
                ]
            );
        }

        await connection.commit();

        return res.json({
            ok: true,
            product: {
                id: productId,
                product_key: productKey,
                product_name: productName,
                display_name: displayName,
                product_label: productLabel,
                category_slug: categorySlug,
                capacity_ml: capacityMl,
                price,
                cost_price: costPrice,
                realization_price: realizationPrice,
                is_active: Boolean(isActive),
                staff_only: true
            }
        });

    } catch (err) {
        try {
            await connection.rollback();
        } catch (rollbackErr) {
            console.error("STAFF ADMIN CREATE PRODUCT ROLLBACK ERROR:", rollbackErr);
        }

        console.error("STAFF ADMIN CREATE PRODUCT ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });

    } finally {
        connection.release();
    }
});

app.post("/api/staff/admin-update-product", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const productId = Number(req.body.productId || 0);
        const productName = normalizeStaffProductName(req.body.productName);
        const price = normalizeStaffProductPrice(req.body.price);
        const costPrice = normalizeStaffProductPrice(req.body.costPrice);
        const realizationPrice = normalizeStaffProductPrice(req.body.realizationPrice);
        const isActive = Number(req.body.isActive) === 1 ? 1 : 0;

        const access = await getStaffAdminToolsManagerOrDeny(staffId);

        if (!access.ok) {
            return res.status(access.status).json({
                ok: false,
                error: access.error
            });
        }

        if (!productId) {
            return res.status(400).json({
                ok: false,
                error: "Не передано ID товару"
            });
        }

        if (!productName) {
            return res.status(400).json({
                ok: false,
                error: "Вкажіть назву товару"
            });
        }

        const [productRows] = await connection.query(
            `
            SELECT
                id,
                product_key,
                product_name,
                display_name,
                product_label,
                category_slug,
                capacity_ml
            FROM products_catalog
            WHERE id = ?
            LIMIT 1
            `,
            [productId]
        );

        if (!productRows.length) {
            return res.status(404).json({
                ok: false,
                error: "Товар не знайдено"
            });
        }

        const currentProduct = productRows[0];

        const displayName = buildStaffProductDisplayName({
            productLabel: currentProduct.product_label,
            productName,
            capacityMl: currentProduct.capacity_ml
        });

        await connection.beginTransaction();

        await connection.query(
            `
            UPDATE products_catalog
            SET
                product_name = ?,
                display_name = ?,
                price = ?,
                cost_price = ?,
                realization_price = ?,
                is_active = ?
            WHERE id = ?
            `,
            [
                productName,
                displayName,
                price,
                costPrice,
                realizationPrice,
                isActive,
                productId
            ]
        );

        await connection.query(
            `
            UPDATE stock_balances
            SET
                product_display_name = ?,
                retail_price = ?,
                cost_price = ?,
                realization_price = ?
            WHERE product_id = ?
            `,
            [
                displayName,
                price,
                costPrice,
                realizationPrice,
                productId
            ]
        );

        await connection.commit();

        return res.json({
            ok: true,
            product: {
                id: productId,
                product_key: currentProduct.product_key,
                product_name: productName,
                display_name: displayName,
                product_label: currentProduct.product_label,
                category_slug: currentProduct.category_slug,
                capacity_ml: currentProduct.capacity_ml,
                price,
                cost_price: costPrice,
                realization_price: realizationPrice,
                is_active: Boolean(isActive)
            }
        });

    } catch (err) {
        try {
            await connection.rollback();
        } catch (rollbackErr) {
            console.error("STAFF ADMIN UPDATE PRODUCT ROLLBACK ERROR:", rollbackErr);
        }

        console.error("STAFF ADMIN UPDATE PRODUCT ERROR:", err);

        return res.status(500).json({
            ok: false,
            error: "server error"
        });

    } finally {
        connection.release();
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
        const certificateCode = String(req.body.certificateCode || "").trim().toUpperCase();
        const customerSource = String(req.body.customerSource || "").trim() || null;
        const personalPromoCode = String(req.body.promoCode || "").trim().toUpperCase();
        const selectedPublicPromoCodeId = Number(req.body.selectedPublicPromoCodeId || 0);
        const personalGiftOfferId = Number(req.body.personalGiftOfferId || 0);
        const personalPercentOfferId = Number(req.body.personalPercentOfferId || 0);
        const skipPublicPromo = Boolean(req.body.skipPublicPromo);

        const bodyItems = Array.isArray(req.body.items) ? req.body.items : [];

        const isStaffMonoPayment =
            paymentType === "mono_qr" ||
            paymentType === "certificate_mono_qr";

        if (!isStaffMonoPayment) {
            return res.status(400).json({
                ok: false,
                error: "Для цього маршруту доступна тільки оплата Mono QR"
            });
        }

        if (paymentType === "certificate_mono_qr" && !certificateCode) {
            return res.status(400).json({
                ok: false,
                error: "Вкажіть код сертифіката"
            });
        }

        const saleItems = bodyItems.map(item => ({
            productId: Number(item.productId || item.product_id || 0),
            quantity: Number(item.quantity || 0),
            discoveryAromas: Array.isArray(item.discoveryAromas)
                ? item.discoveryAromas
                    .map(aroma => String(aroma || "").trim())
                    .filter(Boolean)
                : []
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

        const assignedWarehouseId = Number(staff.warehouse_id || 0);

        const warehouseId =
            assignedWarehouseId > 0
                ? assignedWarehouseId
                : staff.role === "admin"
                    ? warehouseIdFromBody
                    : 0;

        if (!warehouseId) {
            return res.status(400).json({
                ok: false,
                error: "Оберіть склад продажу"
            });
        }

        const [warehouseRows] = await connection.query(
            `
            SELECT
                MAX(warehouse_name) AS warehouse_name
            FROM stock_balances
            WHERE warehouse_id = ?
            `,
            [warehouseId]
        );

        const saleWarehouseName =
            warehouseRows[0]?.warehouse_name || `Склад ${warehouseId}`;

        const saleRows = [];
        const outOfStockItems = [];

        for (const saleItem of saleItems) {
            const [productRows] = await connection.query(
                `
                SELECT
                    id,
                    product_key,
                    display_name,
                    product_label,
                    price,
                    cost_price,
                    realization_price,
                    category_slug
                FROM products_catalog
                WHERE id = ?
                  AND is_active = 1
                LIMIT 1
                `,
                [saleItem.productId]
            );

            if (!productRows.length) {
                return res.status(404).json({
                    ok: false,
                    error: "Товар не знайдено в каталозі"
                });
            }

            const product = productRows[0];

            const isCertificateProduct = isStaffCertificateStock(product);
            const isDiscoveryProduct = isStaffDiscoveryProduct(product);
            const isStockManagedProduct = isStaffStockManagedProduct(product);

            let stock = null;
            let currentBalance = null;

            if (isStockManagedProduct) {
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
                    `,
                    [warehouseId, saleItem.productId]
                );

                if (!stockRows.length) {
                    return res.status(404).json({
                        ok: false,
                        error: "Товар не знайдено на обраному складі"
                    });
                }

                stock = stockRows[0];

                currentBalance =
                    stock.final_quantity !== null && stock.final_quantity !== undefined
                        ? Number(stock.final_quantity || 0)
                        : Number(stock.initial_quantity || 0) - Number(stock.sales_quantity || 0);

                if (
                    !allowOutOfStock &&
                    currentBalance < saleItem.quantity
                ) {
                    outOfStockItems.push({
                        productName: stock.product_display_name,
                        currentBalance,
                        requestedQuantity: saleItem.quantity
                    });
                }
            } else {
                stock = {
                    id: null,
                    warehouse_id: warehouseId,
                    warehouse_name: saleWarehouseName,
                    product_id: product.id,
                    product_key: product.product_key,
                    product_display_name: product.display_name,
                    retail_price: product.price,
                    cost_price: product.cost_price,
                    realization_price: product.realization_price,
                    initial_quantity: 0,
                    sales_quantity: 0,
                    final_quantity: null
                };

                currentBalance = null;
            }

            stock.product_label = product.product_label;
            stock.category_slug = product.category_slug;
            stock.catalog_display_name = product.display_name;            

            const unitPrice = Number(stock.retail_price || 0);

            saleRows.push({
                stock,
                quantity: saleItem.quantity,
                currentBalance,
                unitPrice,
                rowTotal: unitPrice * saleItem.quantity,
                isCertificateProduct,
                isDiscoveryProduct,
                isStockManagedProduct,
                discoveryAromas: Array.isArray(saleItem.discoveryAromas)
                    ? saleItem.discoveryAromas
                        .map(aroma => String(aroma || "").trim())
                        .filter(Boolean)
                    : []
            });
        }

        const discoveryMovementRows = [];

        const discoverySaleRows = saleRows.filter(row =>
            row.isDiscoveryProduct &&
            Array.isArray(row.discoveryAromas) &&
            row.discoveryAromas.length
        );

        if (discoverySaleRows.length) {
            const [testerRows] = await connection.query(
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
                    p.product_key AS catalog_product_key,
                    p.display_name AS catalog_display_name,
                    p.product_label,
                    p.category_slug
                FROM stock_balances sb
                LEFT JOIN products_catalog p
                    ON p.id = sb.product_id
                WHERE sb.warehouse_id = ?
                `,
                [warehouseId]
            );

            const testerStockRows = testerRows.filter(tester =>
                isStaffTesterProduct({
                    product_key: tester.product_key || tester.catalog_product_key,
                    product_display_name: tester.product_display_name,
                    display_name: tester.catalog_display_name,
                    product_label: tester.product_label,
                    category_slug: tester.category_slug
                })
            );

            for (const discoveryRow of discoverySaleRows) {
                for (const aromaName of discoveryRow.discoveryAromas) {
                    const cleanAromaName = String(aromaName || "").trim();

                    if (!cleanAromaName) {
                        continue;
                    }

                    const testerStock = testerStockRows.find(tester =>
                        isStaffDiscoveryAromaMatch(
                            {
                                product_key: tester.product_key || tester.catalog_product_key,
                                product_display_name: tester.product_display_name,
                                display_name: tester.catalog_display_name
                            },
                            cleanAromaName
                        )
                    );

                    if (!testerStock) {
                        return res.status(404).json({
                            ok: false,
                            error: `Тестер для Discovery не знайдено на обраному складі: ${cleanAromaName}`
                        });
                    }

                    const existingMovementRow = discoveryMovementRows.find(movementRow =>
                        Number(movementRow.stock.id || 0) === Number(testerStock.id || 0)
                    );

                    if (existingMovementRow) {
                        existingMovementRow.quantity += 1;
                    } else {
                        discoveryMovementRows.push({
                            stock: testerStock,
                            quantity: 1
                        });
                    }
                }
            }

            for (const movementRow of discoveryMovementRows) {
                const stock = movementRow.stock;

                const currentBalance =
                    stock.final_quantity !== null && stock.final_quantity !== undefined
                        ? Number(stock.final_quantity || 0)
                        : Number(stock.initial_quantity || 0) - Number(stock.sales_quantity || 0);

                if (
                    !allowOutOfStock &&
                    currentBalance < movementRow.quantity
                ) {
                    outOfStockItems.push({
                        productName: `${stock.product_display_name} (у Discovery)`,
                        currentBalance,
                        requestedQuantity: movementRow.quantity
                    });
                }
            }
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

        const grossTotalAmount = saleRows.reduce((sum, row) => sum + row.rowTotal, 0);

        const availablePublicPromoCodes = skipPublicPromo
            ? []
            : await getStaffPublicPromoCodeOptions(
                connection,
                saleRows,
                warehouseId,
                customerId
            );

        const selectedPublicPromoCodeOption = getSelectedStaffPublicPromoCodeOption(
            availablePublicPromoCodes,
            selectedPublicPromoCodeId
        );

        if (selectedPublicPromoCodeId && !selectedPublicPromoCodeOption) {
            return res.status(400).json({
                ok: false,
                error: "Загальний промокод неактивний або недоступний для цього складу"
            });
        }

        if (
            selectedPublicPromoCodeOption &&
            !selectedPublicPromoCodeOption.available
        ) {
            return res.status(400).json({
                ok: false,
                error: selectedPublicPromoCodeOption.message || "Загальний промокод не застосовано"
            });
        }

        const publicPromoCodeDiscountAmount = selectedPublicPromoCodeOption
            ? Math.min(
                grossTotalAmount,
                Number(selectedPublicPromoCodeOption.discountAmount || 0)
            )
            : 0;

        const totalAfterPublicPromoCode = Math.max(
            0,
            grossTotalAmount - publicPromoCodeDiscountAmount
        );

        const focusPromoDiscount =
            skipPublicPromo || publicPromoCodeDiscountAmount > 0
                ? {
                    discountAmount: 0,
                    note: ""
                }
                : await calculateStaffFocusProductDiscount(
                    connection,
                    saleRows,
                    warehouseId,
                    customerId
                );

        const focusProductDiscountAmount = Math.min(
            totalAfterPublicPromoCode,
            Number(focusPromoDiscount.discountAmount || 0)
        );

        const totalAfterFocusPromo = Math.max(
            0,
            totalAfterPublicPromoCode - focusProductDiscountAmount
        );

        const welcomeDiscount = await calculateStaffWelcomeDiscount(
            connection,
            saleRows,
            customerId,
            warehouseId
        );

        const welcomeDiscountAmount = Math.min(
            totalAfterFocusPromo,
            Number(welcomeDiscount.discountAmount || 0)
        );

        const totalAfterWelcomeDiscount = Math.max(
            0,
            totalAfterFocusPromo - welcomeDiscountAmount
        );

        const statusDiscount = await calculateStaffCustomerStatusDiscount(
            connection,
            saleRows,
            customerId,
            warehouseId,
            focusProductDiscountAmount > 0
        );

        const statusDiscountAmount = Math.min(
            totalAfterWelcomeDiscount,
            Number(statusDiscount.discountAmount || 0)
        );

        const totalAfterStatusDiscount = Math.max(
            0,
            totalAfterWelcomeDiscount - statusDiscountAmount
        );

        const personalPromoCodeDiscount = await calculateStaffPersonalPromoCodeDiscount(
            connection,
            saleRows,
            customerId,
            personalPromoCode
        );

        if (personalPromoCode && !personalPromoCodeDiscount.isValid) {
            return res.status(400).json({
                ok: false,
                error: personalPromoCodeDiscount.message || "Промокод не застосовано"
            });
        }

        const personalPromoCodeDiscountAmount = Math.min(
            totalAfterStatusDiscount,
            Number(personalPromoCodeDiscount.discountAmount || 0)
        );

        const totalAfterPersonalPromoCode = Math.max(
            0,
            totalAfterStatusDiscount - personalPromoCodeDiscountAmount
        );

        const personalPercentOfferDiscount = await calculateStaffSelectedPersonalPercentOfferDiscount(
            connection,
            saleRows,
            customerId,
            personalPercentOfferId,
            totalAfterPersonalPromoCode
        );

        if (personalPercentOfferId && !personalPercentOfferDiscount.isValid) {
            return res.status(400).json({
                ok: false,
                error: personalPercentOfferDiscount.message || "Персональна % знижка не застосована"
            });
        }

        const personalPercentOfferDiscountAmount = Math.min(
            totalAfterPersonalPromoCode,
            Number(personalPercentOfferDiscount.discountAmount || 0)
        );

        const totalAmount = Math.max(
            0,
            totalAfterPersonalPromoCode - personalPercentOfferDiscountAmount
        );

        const focusPromoNote = focusProductDiscountAmount > 0
            ? focusPromoDiscount.note || `Аромат дня: -${focusProductDiscountAmount} грн`
            : "";

        const publicPromoCodeNote = publicPromoCodeDiscountAmount > 0
            ? selectedPublicPromoCodeOption.note || `Загальний промокод: -${publicPromoCodeDiscountAmount} грн`
            : "";

        const welcomeDiscountNote = welcomeDiscountAmount > 0
            ? welcomeDiscount.note || `Welcome-знижка 10%: -${welcomeDiscountAmount} грн`
            : "";

        const statusDiscountNote = statusDiscountAmount > 0
            ? statusDiscount.note || `Персональна знижка: -${statusDiscountAmount} грн`
            : "";

        const personalPromoCodeNote = personalPromoCodeDiscountAmount > 0
            ? personalPromoCodeDiscount.note || `Промокод ${personalPromoCode}: -${personalPromoCodeDiscountAmount} грн`
            : "";

        const personalPercentOfferNote = personalPercentOfferDiscountAmount > 0
            ? personalPercentOfferDiscount.note || `Персональна % знижка: -${personalPercentOfferDiscountAmount} грн`
            : "";
        
        if (!grossTotalAmount || grossTotalAmount <= 0) {
            return res.status(400).json({
                ok: false,
                error: "Сума продажу має бути більше 0"
            });
        }

        let certificateCoveredAmount = 0;
        let certificateRestAmount = 0;
        let paymentAmount = totalAmount;

        if (
            saleRows.some(row => row.isCertificateProduct) &&
            paymentType === "certificate_mono_qr"
        ) {
            return res.status(400).json({
                ok: false,
                error: "Сертифікат не можна оплатити сертифікатом. Оберіть Mono QR без сертифіката."
            });
        }

        if (paymentType === "certificate_mono_qr") {
            const sheetResult = await sheets.spreadsheets.values.get({
                spreadsheetId: SHEET_ID,
                range: `${SHEET_NAME}!A:H`,
            });

            const sheetRows = sheetResult.data.values || [];
            const sheetRow = sheetRows.find(row =>
                String(row[0] || "").trim().toUpperCase() === certificateCode
            );

            if (!sheetRow) {
                return res.status(400).json({
                    ok: false,
                    error: "Сертифікат не знайдено в Google таблиці"
                });
            }

            const sheetStatus = String(sheetRow[6] || "").trim().toLowerCase();
            const sheetExpiresAt = sheetRow[3] || null;

            if (sheetStatus !== "active") {
                return res.status(400).json({
                    ok: false,
                    error: "Сертифікат вже використаний або неактивний"
                });
            }

            if (sheetExpiresAt && new Date(sheetExpiresAt) < new Date()) {
                return res.status(400).json({
                    ok: false,
                    error: "Сертифікат прострочений у Google таблиці"
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
                `,
                [certificateCode]
            );

            if (!certRows.length) {
                return res.status(400).json({
                    ok: false,
                    error: "Сертифікат не знайдено в БД"
                });
            }

            const cert = certRows[0];
            const certStatus = String(cert.status || "").trim().toLowerCase();

            if (certStatus !== "active") {
                return res.status(400).json({
                    ok: false,
                    error: "Сертифікат вже використаний або неактивний"
                });
            }

            if (cert.expires_at && new Date(cert.expires_at) < new Date()) {
                return res.status(400).json({
                    ok: false,
                    error: "Сертифікат прострочений"
                });
            }

            const certificateNominal = Number(cert.nominal || sheetRow[1] || 0);

            if (!certificateNominal || certificateNominal <= 0) {
                return res.status(400).json({
                    ok: false,
                    error: "Некоректний номінал сертифіката"
                });
            }

            certificateCoveredAmount = Math.min(certificateNominal, totalAmount);
            certificateRestAmount = Math.max(0, totalAmount - certificateNominal);
            paymentAmount = certificateRestAmount;

            if (paymentAmount <= 0) {
                return res.status(400).json({
                    ok: false,
                    error: "Сертифікат повністю покриває чек. Оберіть тип оплати “Сертифікат”."
                });
            }
        }

        const orderId = "STAFF-MONO-" + Date.now();

        const salePayload = {
            staffId,
            customerId,
            customerSource,
            items: saleItems,
            paymentType,
            warehouseId,
            certificateCode: paymentType === "certificate_mono_qr" ? certificateCode : null,
            promoCode: personalPromoCode || "",
            selectedPublicPromoCodeId: publicPromoCodeDiscountAmount > 0 && selectedPublicPromoCodeOption
                ? Number(selectedPublicPromoCodeOption.campaignId || 0)
                : 0,
            personalGiftOfferId,
            personalPercentOfferId,
            skipPublicPromo,
            allowOutOfStock,
            orderId
        };

        const pageUrl = await createMonoPaymentPageUrl({
            amount: paymentAmount,
            orderId,
            destination: `Mōnal staff sale ${orderId}`,
            redirectUrl: "https://monal.com.ua/account/staff-cabinet.html"
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
                paymentType,
                totalAmount,
                paymentAmount,
                paymentType === "certificate_mono_qr" ? certificateCode : null,
                allowOutOfStock ? 1 : 0,
                JSON.stringify(salePayload)
            ]
        );

        return res.json({
            ok: true,
            orderId,
            pageUrl,
            grossTotalAmount,
            focusProductDiscountAmount,
            focusPromoNote,
            publicPromoCodeDiscountAmount,
            publicPromoCodeNote,
            welcomeDiscountAmount,
            welcomeDiscountNote,
            statusDiscountAmount,
            statusDiscountNote,
            personalPromoCodeDiscountAmount,
            personalPromoCodeNote,
            personalPercentOfferDiscountAmount,
            personalPercentOfferNote,
            totalAmount,
            paymentAmount,
            certificateCode: paymentType === "certificate_mono_qr" ? certificateCode : null,
            certificateCoveredAmount,
            certificateRestAmount
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
        const customerSource = String(req.body.customerSource || "").trim() || null;
        const personalPromoCode = String(req.body.promoCode || "").trim().toUpperCase();
        const selectedPublicPromoCodeId = Number(req.body.selectedPublicPromoCodeId || 0);
        const personalGiftOfferId = Number(req.body.personalGiftOfferId || 0);
        const personalPercentOfferId = Number(req.body.personalPercentOfferId || 0);
        const skipPublicPromo = Boolean(req.body.skipPublicPromo);

        const bodyItems = Array.isArray(req.body.items) ? req.body.items : [];

        const saleItems = bodyItems.length
            ? bodyItems.map(item => ({
                productId: Number(item.productId || item.product_id || 0),
                quantity: Number(item.quantity || 0),
                discoveryAromas: Array.isArray(item.discoveryAromas)
                    ? item.discoveryAromas
                        .map(aroma => String(aroma || "").trim())
                        .filter(Boolean)
                    : []
            }))
            : [
                {
                    productId: Number(req.body.productId || 0),
                    quantity: Number(req.body.quantity || 0),
                    discoveryAromas: []
                }
            ];

        if (!staffId || !paymentType || !saleItems.length) {
            return res.status(400).json({
                ok: false,
                error: "Заповніть товари і тип оплати"
            });
        }

        const requiresMonoInvoice =
            paymentType === "mono_qr" ||
            paymentType === "certificate_mono_qr";

        if (
            requiresMonoInvoice &&
            !externalOrderId.startsWith("STAFF-MONO-")
        ) {
            return res.status(400).json({
                ok: false,
                error: "Для Mono QR спочатку потрібно створити посилання на оплату."
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

        const assignedWarehouseId = Number(staff.warehouse_id || 0);

        const warehouseId =
            assignedWarehouseId > 0
                ? assignedWarehouseId
                : staff.role === "admin"
                    ? warehouseIdFromBody
                    : 0;

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

        const [warehouseRows] = await connection.query(
            `
            SELECT
                MAX(warehouse_name) AS warehouse_name
            FROM stock_balances
            WHERE warehouse_id = ?
            `,
            [warehouseId]
        );

        const saleWarehouseName =
            warehouseRows[0]?.warehouse_name || `Склад ${warehouseId}`;

        const saleRows = [];
        const outOfStockItems = [];

        for (const saleItem of saleItems) {
            const [productRows] = await connection.query(
                `
                SELECT
                    id,
                    product_key,
                    display_name,
                    product_label,
                    price,
                    cost_price,
                    realization_price,
                    category_slug
                FROM products_catalog
                WHERE id = ?
                  AND is_active = 1
                LIMIT 1
                `,
                [saleItem.productId]
            );

            if (!productRows.length) {
                await connection.rollback();

                return res.status(404).json({
                    ok: false,
                    error: "Товар не знайдено в каталозі"
                });
            }

            const product = productRows[0];

            const isCertificateProduct = isStaffCertificateStock(product);
            const isDiscoveryProduct = isStaffDiscoveryProduct(product);
            const isStockManagedProduct = isStaffStockManagedProduct(product);

            let stock = null;
            let currentBalance = null;

            if (isStockManagedProduct) {
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

                stock = stockRows[0];

                currentBalance =
                    stock.final_quantity !== null && stock.final_quantity !== undefined
                        ? Number(stock.final_quantity || 0)
                        : Number(stock.initial_quantity || 0) - Number(stock.sales_quantity || 0);

                if (
                    !allowOutOfStock &&
                    currentBalance < saleItem.quantity
                ) {
                    outOfStockItems.push({
                        productName: stock.product_display_name,
                        currentBalance,
                        requestedQuantity: saleItem.quantity
                    });
                }
            } else {
                stock = {
                    id: null,
                    warehouse_id: warehouseId,
                    warehouse_name: saleWarehouseName,
                    product_id: product.id,
                    product_key: product.product_key,
                    product_display_name: product.display_name,
                    retail_price: product.price,
                    cost_price: product.cost_price,
                    realization_price: product.realization_price,
                    initial_quantity: 0,
                    sales_quantity: 0,
                    final_quantity: null
                };

                currentBalance = null;
            }

            stock.product_label = product.product_label;
            stock.category_slug = product.category_slug;
            stock.catalog_display_name = product.display_name;

            const unitPrice = Number(stock.retail_price || 0);

            const rowTotal = unitPrice * saleItem.quantity;

            saleRows.push({
                stock,
                quantity: saleItem.quantity,
                currentBalance,
                unitPrice,
                rowTotal,
                isCertificateProduct,
                isDiscoveryProduct,
                isStockManagedProduct,
                discoveryAromas: Array.isArray(saleItem.discoveryAromas)
                    ? saleItem.discoveryAromas
                        .map(aroma => String(aroma || "").trim())
                        .filter(Boolean)
                    : []
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

        const grossTotalAmount = saleRows.reduce((sum, row) => sum + row.rowTotal, 0);
        const totalQuantity = saleRows.reduce((sum, row) => sum + row.quantity, 0);

        const selectedManualPromoCount = [
            selectedPublicPromoCodeId > 0,
            Boolean(personalPromoCode),
            personalGiftOfferId > 0,
            personalPercentOfferId > 0
        ].filter(Boolean).length;

        if (selectedManualPromoCount > 1) {
            await connection.rollback();

            return res.status(400).json({
                ok: false,
                error: "В одному чеку можна застосувати тільки одну промопропозицію"
            });
        }

        const hasSelectedPersonalPromo =
            Boolean(personalPromoCode) ||
            personalGiftOfferId > 0 ||
            personalPercentOfferId > 0;

        const shouldSkipPublicPromos =
            skipPublicPromo ||
            hasSelectedPersonalPromo;

        const availablePublicPromoCodes = shouldSkipPublicPromos
            ? []
            : await getStaffPublicPromoCodeOptions(
                connection,
                saleRows,
                warehouseId,
                customerId
            );

        const selectedPublicPromoCodeOption = getSelectedStaffPublicPromoCodeOption(
            availablePublicPromoCodes,
            selectedPublicPromoCodeId
        );

        if (selectedPublicPromoCodeId && !selectedPublicPromoCodeOption) {
            await connection.rollback();

            return res.status(400).json({
                ok: false,
                error: "Загальний промокод неактивний або недоступний для цього складу"
            });
        }

        if (
            selectedPublicPromoCodeOption &&
            !selectedPublicPromoCodeOption.available
        ) {
            await connection.rollback();

            return res.status(400).json({
                ok: false,
                error: selectedPublicPromoCodeOption.message || "Загальний промокод не застосовано"
            });
        }

        const publicPromoCodeDiscountAmount = selectedPublicPromoCodeOption
            ? Math.min(
                grossTotalAmount,
                Number(selectedPublicPromoCodeOption.discountAmount || 0)
            )
            : 0;

        const totalAfterPublicPromoCode = Math.max(
            0,
            grossTotalAmount - publicPromoCodeDiscountAmount
        );

        const focusPromoDiscount =
            shouldSkipPublicPromos || publicPromoCodeDiscountAmount > 0
                ? {
                    discountAmount: 0,
                    note: ""
                }
                : await calculateStaffFocusProductDiscount(
                    connection,
                    saleRows,
                    warehouseId,
                    customerId
                );

        const focusProductDiscountAmount = Math.min(
            totalAfterPublicPromoCode,
            Number(focusPromoDiscount.discountAmount || 0)
        );

        const totalAfterFocusPromo = Math.max(
            0,
            totalAfterPublicPromoCode - focusProductDiscountAmount
        );

        const publicGiftPromo =
            shouldSkipPublicPromos ||
            publicPromoCodeDiscountAmount > 0 ||
            focusProductDiscountAmount > 0
                ? {
                    isValid: true,
                    campaign: null,
                    giftStock: null,
                    note: ""
                }
                : await calculateStaffPublicGiftPromo(
                    connection,
                    saleRows,
                    warehouseId,
                    customerId,
                    {
                        allowOutOfStock,
                        lockStock: true
                    }
                );

        if (!publicGiftPromo.isValid) {
            await connection.rollback();

            return res.status(400).json({
                ok: false,
                code: publicGiftPromo.code,
                outOfStockItems: publicGiftPromo.outOfStockItems,
                productName: publicGiftPromo.productName,
                currentBalance: publicGiftPromo.currentBalance,
                requestedQuantity: publicGiftPromo.requestedQuantity,
                error: publicGiftPromo.error || "Загальний подарунок не застосовано"
            });
        }

        const publicGiftStock = publicGiftPromo.giftStock || null;

        const welcomeDiscount = await calculateStaffWelcomeDiscount(
            connection,
            saleRows,
            customerId,
            warehouseId
        );

        const welcomeDiscountAmount = Math.min(
            totalAfterFocusPromo,
            Number(welcomeDiscount.discountAmount || 0)
        );

        const totalAfterWelcomeDiscount = Math.max(
            0,
            totalAfterFocusPromo - welcomeDiscountAmount
        );

        const statusDiscount = await calculateStaffCustomerStatusDiscount(
            connection,
            saleRows,
            customerId,
            warehouseId,
            focusProductDiscountAmount > 0
        );

        const statusDiscountAmount = Math.min(
            totalAfterWelcomeDiscount,
            Number(statusDiscount.discountAmount || 0)
        );

        const totalAfterStatusDiscount = Math.max(
            0,
            totalAfterWelcomeDiscount - statusDiscountAmount
        );

        const personalPromoCodeDiscount = await calculateStaffPersonalPromoCodeDiscount(
            connection,
            saleRows,
            customerId,
            personalPromoCode
        );

        if (personalPromoCode && !personalPromoCodeDiscount.isValid) {
            await connection.rollback();

            return res.status(400).json({
                ok: false,
                error: personalPromoCodeDiscount.message || "Промокод не застосовано"
            });
        }

        const personalPromoCodeDiscountAmount = Math.min(
            totalAfterStatusDiscount,
            Number(personalPromoCodeDiscount.discountAmount || 0)
        );

        const totalAfterPersonalPromoCode = Math.max(
            0,
            totalAfterStatusDiscount - personalPromoCodeDiscountAmount
        );

        const personalPercentOfferDiscount = await calculateStaffSelectedPersonalPercentOfferDiscount(
            connection,
            saleRows,
            customerId,
            personalPercentOfferId,
            totalAfterPersonalPromoCode
        );

        if (personalPercentOfferId && !personalPercentOfferDiscount.isValid) {
            await connection.rollback();

            return res.status(400).json({
                ok: false,
                error: personalPercentOfferDiscount.message || "Персональна % знижка не застосована"
            });
        }

        const personalPercentOfferDiscountAmount = Math.min(
            totalAfterPersonalPromoCode,
            Number(personalPercentOfferDiscount.discountAmount || 0)
        );

        const totalAmount = Math.max(
            0,
            totalAfterPersonalPromoCode - personalPercentOfferDiscountAmount
        );

        const focusPromoNote = focusProductDiscountAmount > 0
            ? `, ${focusPromoDiscount.note || `Аромат дня: -${focusProductDiscountAmount} грн`}`
            : "";

        const publicPromoCodeNote = publicPromoCodeDiscountAmount > 0
            ? `, ${selectedPublicPromoCodeOption.note || `Загальний промокод: -${publicPromoCodeDiscountAmount} грн`}`
            : "";        

        const welcomeDiscountNote = welcomeDiscountAmount > 0
            ? `, ${welcomeDiscount.note || `Welcome-знижка 10%: -${welcomeDiscountAmount} грн`}`
            : "";

        const statusDiscountNote = statusDiscountAmount > 0
            ? `, ${statusDiscount.note || `Персональна знижка: -${statusDiscountAmount} грн`}`
            : "";

        const personalPromoCodeNote = personalPromoCodeDiscountAmount > 0
            ? `, ${personalPromoCodeDiscount.note || `Промокод ${personalPromoCode}: -${personalPromoCodeDiscountAmount} грн`}`
            : "";

        const personalPercentOfferNote = personalPercentOfferDiscountAmount > 0
            ? `, ${personalPercentOfferDiscount.note || `Персональна % знижка: -${personalPercentOfferDiscountAmount} грн`}`
            : "";

        const publicGiftPromoNote = publicGiftStock
            ? `, ${publicGiftPromo.note || `Діє акція: у подарунок ${publicGiftStock.product_display_name}.`}`
            : "";

        const shouldMarkWelcomeDiscountUsed =
            Boolean(customer && welcomeDiscountAmount > 0 && welcomeDiscount.isAvailable);

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
            let purchasedCertificates = [];

        const isCertificatePayment =
            paymentType === "certificate" ||
            paymentType === "certificate_cash" ||
            paymentType === "certificate_mono_qr";

        if (
            saleRows.some(row => row.isCertificateProduct) &&
            isCertificatePayment
        ) {
            await connection.rollback();

            return res.status(400).json({
                ok: false,
                error: "Сертифікат не можна оплатити сертифікатом. Оберіть готівку, переказ на карту або Mono QR."
            });
        }

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

        let personalGiftOffer = null;
        let personalGiftStock = null;
        let personalGiftNote = "";

        if (personalGiftOfferId) {
            if (!customer) {
                await connection.rollback();

                return res.status(400).json({
                    ok: false,
                    error: "Персональний подарунок доступний тільки для зареєстрованого клієнта"
                });
            }

            const giftCustomerStatus = String(customer.customer_status || "general")
                .trim()
                .toLowerCase();

            const [giftOfferRows] = await connection.query(
                `
                SELECT
                    id,
                    title,
                    offer_text,
                    required_category_slug,
                    required_discount_level,
                    COALESCE(required_customer_status, 'all') AS required_customer_status
                FROM personal_offers
                WHERE id = ?
                  AND offer_type = 'gift'
                  AND is_active = 1
                  AND (starts_at IS NULL OR starts_at <= NOW())
                  AND (ends_at IS NULL OR ends_at >= NOW())
                  AND (
                        COALESCE(required_customer_status, '') = ''
                        OR FIND_IN_SET('all', REPLACE(LOWER(COALESCE(required_customer_status, 'all')), ' ', '')) > 0
                        OR FIND_IN_SET(?, REPLACE(LOWER(COALESCE(required_customer_status, 'all')), ' ', '')) > 0
                  )
                LIMIT 1
                `,
                [
                    personalGiftOfferId,
                    giftCustomerStatus
                ]
            );

            if (!giftOfferRows.length) {
                await connection.rollback();

                return res.status(400).json({
                    ok: false,
                    error: "Персональний подарунок неактивний або недоступний для цього клієнта"
                });
            }

            personalGiftOffer = giftOfferRows[0];

            const giftProductId = Number(personalGiftOffer.required_discount_level || 0);
            const requiredGiftTarget = String(personalGiftOffer.required_category_slug || "").trim();

            function normalizeStaffGiftTargetText(value) {
                return String(value || "")
                    .trim()
                    .toLowerCase()
                    .replace(/ё/g, "е")
                    .replace(/[’ʼ']/g, "")
                    .replace(/[_/\\|–—-]+/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();
            }

            function getStaffGiftCategoryAliases(value) {
                const text = normalizeStaffGiftTargetText(value);
                const aliases = new Set();

                if (!text) {
                    return [];
                }

                aliases.add(text);

                if (
                    text.includes("аромадифузор") ||
                    text.includes("diffuser") ||
                    text.includes("aromadiffuser")
                ) {
                    aliases.add("aromadiffusers");
                    aliases.add("аромадифузори");
                }

                if (
                    text.includes("рефіл") ||
                    text.includes("refill")
                ) {
                    aliases.add("refills");
                    aliases.add("рефіли");
                }

                if (
                    text.includes("парфум") ||
                    text.includes("perfume") ||
                    text.includes("parfum")
                ) {
                    aliases.add("parfums");
                    aliases.add("парфуми");
                    aliases.add("парфуми для дому");
                }

                if (
                    text.includes("discovery") ||
                    text.includes("діскавер")
                ) {
                    aliases.add("discovery");
                    aliases.add("discovery set");
                }

                if (
                    text.includes("подарунковий") ||
                    text.includes("gift")
                ) {
                    aliases.add("gift-sets");
                    aliases.add("подарункові набори");
                }

                if (
                    text.includes("тестер") ||
                    text.includes("tester")
                ) {
                    aliases.add("testers");
                    aliases.add("тестери");
                }

                return Array.from(aliases)
                    .map(item => normalizeStaffGiftTargetText(item))
                    .filter(Boolean);
            }

            function getStaffGiftSaleRowCategoryKeys(row) {
                const stock = row?.stock || {};

                const values = [
                    stock.category_slug,
                    stock.product_label,
                    stock.product_key,
                    stock.product_display_name,
                    stock.catalog_display_name,
                    `${stock.category_slug || ""} ${stock.product_label || ""} ${stock.product_display_name || ""}`
                ];

                return [
                    ...new Set(
                        values.flatMap(value => getStaffGiftCategoryAliases(value))
                    )
                ];
            }

            function isStaffSaleRowEligibleForPersonalGift(row, requiredTarget) {
                const cleanTarget = String(requiredTarget || "").trim();

                if (!cleanTarget) {
                    return false;
                }

                if (row?.isCertificateProduct || isStaffCertificateStock(row?.stock)) {
                    return false;
                }

                if (cleanTarget.toLowerCase().startsWith("products:")) {
                    const allowedProductIds = cleanTarget
                        .replace(/^products:/i, "")
                        .split(",")
                        .map(item => Number(item || 0))
                        .filter(id => Number.isInteger(id) && id > 0);

                    const rowProductId = Number(row?.stock?.product_id || 0);

                    return allowedProductIds.includes(rowProductId);
                }

                const targetKeys = [
                    ...new Set(
                        cleanTarget
                            .split(",")
                            .flatMap(value => getStaffGiftCategoryAliases(value))
                            .filter(Boolean)
                    )
                ];

                if (!targetKeys.length) {
                    return false;
                }

                const rowKeys = getStaffGiftSaleRowCategoryKeys(row);

                return targetKeys.some(targetKey => rowKeys.includes(targetKey));
            }

            const hasGiftConditionMatch = saleRows.some(row =>
                isStaffSaleRowEligibleForPersonalGift(row, requiredGiftTarget)
            );

            if (!hasGiftConditionMatch) {
                await connection.rollback();

                return res.status(400).json({
                    ok: false,
                    error: "У чеку немає товару або категорії, які дають право на цей подарунок"
                });
            }

            if (!giftProductId) {
                await connection.rollback();

                return res.status(400).json({
                    ok: false,
                    error: "У персональному подарунку не вказано товар-подарунок"
                });
            }

            const [giftStockRows] = await connection.query(
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
                    p.product_key AS catalog_product_key,
                    p.display_name AS catalog_display_name,
                    p.product_label,
                    p.category_slug
                FROM stock_balances sb
                LEFT JOIN products_catalog p
                    ON p.id = sb.product_id
                WHERE sb.warehouse_id = ?
                  AND sb.product_id = ?
                LIMIT 1
                FOR UPDATE
                `,
                [
                    warehouseId,
                    giftProductId
                ]
            );

            if (!giftStockRows.length) {
                await connection.rollback();

                return res.status(404).json({
                    ok: false,
                    error: "Товар-подарунок не знайдено на обраному складі"
                });
            }

            personalGiftStock = giftStockRows[0];

            personalGiftStock.product_display_name =
                personalGiftStock.product_display_name ||
                personalGiftStock.catalog_display_name ||
                "Подарунок";

            if (
                isStaffCertificateStock({
                    product_key: personalGiftStock.product_key || personalGiftStock.catalog_product_key,
                    product_display_name: personalGiftStock.product_display_name,
                    display_name: personalGiftStock.catalog_display_name,
                    product_label: personalGiftStock.product_label,
                    category_slug: personalGiftStock.category_slug
                })
            ) {
                await connection.rollback();

                return res.status(400).json({
                    ok: false,
                    error: "Сертифікат не можна списати як подарунок"
                });
            }

            const currentGiftBalance =
                personalGiftStock.final_quantity !== null && personalGiftStock.final_quantity !== undefined
                    ? Number(personalGiftStock.final_quantity || 0)
                    : Number(personalGiftStock.initial_quantity || 0) - Number(personalGiftStock.sales_quantity || 0);

            if (!allowOutOfStock && currentGiftBalance < 1) {
                await connection.rollback();

                return res.status(400).json({
                    ok: false,
                    code: "out_of_stock_confirm_required",
                    outOfStockItems: [
                        {
                            productName: `${personalGiftStock.product_display_name} (подарунок до акції)`,
                            currentBalance: currentGiftBalance,
                            requestedQuantity: 1
                        }
                    ],
                    productName: `${personalGiftStock.product_display_name} (подарунок до акції)`,
                    currentBalance: currentGiftBalance,
                    requestedQuantity: 1,
                    error: "Недостатньо залишку по товару-подарунку"
                });
            }

            personalGiftNote =
                `, подарунок до акції: ${personalGiftStock.product_display_name}`;
        }

        function getStaffSaleProductText(row) {
            const baseName = String(row?.stock?.product_display_name || "Товар").trim();
            const productKey = String(row?.stock?.product_key || "").trim().toLowerCase();
            const lowerName = baseName.toLowerCase();

            const isDiscovery =
                productKey.includes("discovery") ||
                lowerName.includes("discovery") ||
                lowerName.includes("діскавер");

            const aromas = Array.isArray(row.discoveryAromas)
                ? row.discoveryAromas
                    .map(aroma => String(aroma || "").trim())
                    .filter(Boolean)
                : [];

            if (!isDiscovery || !aromas.length) {
                return baseName;
            }

            return `${baseName} (аромати: ${aromas.join(", ")})`;
        }

        const saleItemsText = saleRows.map(row =>
            `${getStaffSaleProductText(row)} × ${row.quantity} — ${row.unitPrice} грн = ${row.rowTotal} грн`
        ).join("\n");

        const personalGiftItemsText = personalGiftStock
            ? `${personalGiftStock.product_display_name} × 1 — 0 грн = 0 грн (персональний подарунок до акції)`
            : "";

        const publicGiftItemsText = publicGiftStock
            ? `${publicGiftStock.product_display_name} × 1 — 0 грн = 0 грн (загальний подарунок до акції)`
            : "";

        const itemsText = [
            saleItemsText,
            personalGiftItemsText,
            publicGiftItemsText
        ]
            .filter(Boolean)
            .join("\n");

        const discoveryMovementRows = [];

        const discoverySaleRows = saleRows.filter(row =>
            row.isDiscoveryProduct &&
            Array.isArray(row.discoveryAromas) &&
            row.discoveryAromas.length
        );

        if (discoverySaleRows.length) {
            const [testerRows] = await connection.query(
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
                    p.product_key AS catalog_product_key,
                    p.display_name AS catalog_display_name,
                    p.product_label,
                    p.category_slug
                FROM stock_balances sb
                LEFT JOIN products_catalog p
                    ON p.id = sb.product_id
                WHERE sb.warehouse_id = ?
                FOR UPDATE
                `,
                [warehouseId]
            );

            const testerStockRows = testerRows.filter(tester =>
                isStaffTesterProduct({
                    product_key: tester.product_key || tester.catalog_product_key,
                    product_display_name: tester.product_display_name,
                    display_name: tester.catalog_display_name,
                    product_label: tester.product_label,
                    category_slug: tester.category_slug
                })
            );

            for (const discoveryRow of discoverySaleRows) {
                for (const aromaName of discoveryRow.discoveryAromas) {
                    const cleanAromaName = String(aromaName || "").trim();

                    if (!cleanAromaName) {
                        continue;
                    }

                    const testerStock = testerStockRows.find(tester =>
                        isStaffDiscoveryAromaMatch(
                            {
                                product_key: tester.product_key || tester.catalog_product_key,
                                product_display_name: tester.product_display_name,
                                display_name: tester.catalog_display_name
                            },
                            cleanAromaName
                        )
                    );

                    if (!testerStock) {
                        await connection.rollback();

                        return res.status(404).json({
                            ok: false,
                            error: `Тестер для Discovery не знайдено на обраному складі: ${cleanAromaName}`
                        });
                    }

                    const existingMovementRow = discoveryMovementRows.find(movementRow =>
                        Number(movementRow.stock.id || 0) === Number(testerStock.id || 0)
                    );

                    if (existingMovementRow) {
                        existingMovementRow.quantity += 1;
                    } else {
                        discoveryMovementRows.push({
                            stock: testerStock,
                            quantity: 1
                        });
                    }
                }
            }

            for (const movementRow of discoveryMovementRows) {
                const stock = movementRow.stock;

                const currentBalance =
                    stock.final_quantity !== null && stock.final_quantity !== undefined
                        ? Number(stock.final_quantity || 0)
                        : Number(stock.initial_quantity || 0) - Number(stock.sales_quantity || 0);

                if (
                    !allowOutOfStock &&
                    currentBalance < movementRow.quantity
                ) {
                    outOfStockItems.push({
                        productName: `${stock.product_display_name} (у Discovery)`,
                        currentBalance,
                        requestedQuantity: movementRow.quantity
                    });
                }
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
        }

        for (const row of saleRows) {
            const stock = row.stock;
            
            if (!row.isStockManagedProduct) {
                continue;
            }

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

        if (publicGiftStock) {
            await connection.query(
                `
                UPDATE stock_balances
                SET sales_quantity = sales_quantity + 1
                WHERE id = ?
                  AND warehouse_id = ?
                `,
                [
                    publicGiftStock.id,
                    warehouseId
                ]
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
                VALUES (?, 'sale_gift', ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
                `,
                [
                    orderId,
                    publicGiftStock.warehouse_id,
                    publicGiftStock.warehouse_name,
                    publicGiftStock.id,
                    publicGiftStock.product_id,
                    publicGiftStock.product_key,
                    `${publicGiftStock.product_display_name} (загальний подарунок до акції)`,
                    publicGiftStock.cost_price,
                    publicGiftStock.realization_price,
                    staff.id,
                    staff.name
                ]
            );
        }        

        if (personalGiftStock) {
            await connection.query(
                `
                UPDATE stock_balances
                SET sales_quantity = sales_quantity + 1
                WHERE id = ?
                  AND warehouse_id = ?
                `,
                [
                    personalGiftStock.id,
                    warehouseId
                ]
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
                VALUES (?, 'sale_gift', ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
                `,
                [
                    orderId,
                    personalGiftStock.warehouse_id,
                    personalGiftStock.warehouse_name,
                    personalGiftStock.id,
                    personalGiftStock.product_id,
                    personalGiftStock.product_key,
                    `${personalGiftStock.product_display_name} (подарунок до акції)`,
                    personalGiftStock.cost_price,
                    personalGiftStock.realization_price,
                    staff.id,
                    staff.name
                ]
            );
        }

        for (const movementRow of discoveryMovementRows) {
            const stock = movementRow.stock;

            await connection.query(
                `
                UPDATE stock_balances
                SET sales_quantity = sales_quantity + ?
                WHERE id = ?
                  AND warehouse_id = ?
                `,
                [movementRow.quantity, stock.id, warehouseId]
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
                VALUES (?, 'sale_discovery', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    orderId,
                    stock.warehouse_id,
                    stock.warehouse_name,
                    stock.id,
                    stock.product_id,
                    stock.product_key,
                    `${stock.product_display_name} (у Discovery)`,
                    movementRow.quantity,
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
                customer_source,
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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                orderId,
                customer ? customer.id : null,
                customer ? (customer.email || null) : null,
                "staff",
                customerSource,
                customer ? (customer.name || "") : "Продаж без клієнта",
                customer ? (customer.phone || "") : "",
                mainWarehouseName,
                itemsText,
                totalAmount,
                paidAmount,
                dueAmount,
                paymentLabel,
                `Staff sale: ${staff.name || "—"} (${staff.role}), склад ${mainWarehouseName || "—"} ID ${warehouseId}${focusPromoNote}${publicPromoCodeNote}${publicGiftPromoNote}${welcomeDiscountNote}${statusDiscountNote}${personalPromoCodeNote}${personalPercentOfferNote}${personalGiftNote}${certificateNote}`
            ]
        );

        for (const row of saleRows) {
            const productKey = String(row.stock.product_key || "").toLowerCase();
            const productName = String(row.stock.product_display_name || "").toLowerCase();

            const isPurchasedCertificate =
                productKey.startsWith("certificate_") ||
                productName.includes("сертифікат");

            if (!isPurchasedCertificate) continue;

            const nominal = Number(row.unitPrice || row.stock.retail_price || 0);

            if (!nominal || nominal <= 0) continue;

            for (let i = 0; i < Number(row.quantity || 0); i++) {
                const createdCertificate = await createPurchasedCertificate({
                    connection,
                    orderId,
                    ownerUserId: customer ? customer.id : null,
                    nominal,
                    certificateType: "фізичний"
                });

                purchasedCertificates.push(createdCertificate);
            }
        }

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

            if (shouldMarkWelcomeDiscountUsed) {
                await connection.query(
                    `
                    UPDATE customers
                    SET
                        total_spent = ?,
                        discount = ?,
                        welcome_discount_used = 1
                    WHERE id = ?
                    `,
                    [newTotalSpent, newDiscount, customer.id]
                );
            } else {
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
                grossTotalAmount,
                focusProductDiscountAmount,
                focusPromoNote,
                publicPromoCodeDiscountAmount,
                publicPromoCodeNote,
                welcomeDiscountAmount,
                welcomeDiscountNote,
                statusDiscountAmount,
                statusDiscountNote,
                personalPromoCodeDiscountAmount,
                personalPromoCodeNote,
                personalPercentOfferDiscountAmount,
                personalPercentOfferNote,
                publicGiftPromoNote,
                publicGiftProductName: publicGiftStock
                    ? publicGiftStock.product_display_name
                    : "",
                totalAmount,
                paymentLabel,
                customerName: customer ? customer.name : "Без клієнта",
                itemsText,
                items: saleRows.map(row => ({
                    productName: row.stock.product_display_name,
                    quantity: row.quantity,
                    unitPrice: row.unitPrice,
                    rowTotal: row.rowTotal,
                    stockBefore: row.isCertificateProduct ? null : row.currentBalance,
                    stockAfter: row.isCertificateProduct ? null : row.currentBalance - row.quantity,
                    isCertificate: Boolean(row.isCertificateProduct)
                })),
                outOfStockAllowed: saleRows.some(row =>
                    !row.isCertificateProduct && row.currentBalance < row.quantity
                ),
                purchasedCertificates
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
              AND NOT (
                    LOWER(TRIM(COALESCE(p.product_key, ''))) LIKE 'certificate_%'
                    OR LOWER(TRIM(COALESCE(p.display_name, ''))) LIKE '%сертифікат%'
                    OR LOWER(TRIM(COALESCE(p.category_slug, ''))) IN ('discovery', 'discovery-set')
                    OR LOWER(TRIM(COALESCE(p.product_key, ''))) LIKE '%discovery%'
                    OR LOWER(TRIM(COALESCE(p.display_name, ''))) LIKE '%discovery%'
                    OR LOWER(TRIM(COALESCE(p.display_name, ''))) LIKE '%діскавер%'
                    OR LOWER(TRIM(COALESCE(p.product_label, ''))) LIKE '%discovery%'
                    OR LOWER(TRIM(COALESCE(p.product_label, ''))) LIKE '%діскавер%'
              )
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

/* ===================== STAFF: UPDATE WAREHOUSE ===================== */

app.post("/api/staff/update-warehouse", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const staffId = Number(req.body.staffId || 0);
        const warehouseId = Number(req.body.warehouseId || 0);
        const warehouseName = String(req.body.warehouseName || "").trim();
        const supplierDetails = String(req.body.supplierDetails || "").trim() || null;
        const buyerDetails = String(req.body.buyerDetails || "").trim() || null;
        const documentBasis = String(req.body.documentBasis || "").trim() || null;
        const actCity = String(req.body.actCity || "").trim() || null;

        if (!staffId || !warehouseId || !warehouseName) {
            return res.status(400).json({
                ok: false,
                error: "missing fields"
            });
        }

        if (!supplierDetails || !buyerDetails || !documentBasis || !actCity) {
            return res.status(400).json({
                ok: false,
                error: "Заповніть всі реквізити складу для актів"
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
            SELECT warehouse_id
            FROM stock_balances
            WHERE warehouse_id = ?
            LIMIT 1
            `,
            [warehouseId]
        );

        if (!warehouseRows.length) {
            return res.status(404).json({
                ok: false,
                error: "Склад не знайдено"
            });
        }

        const [sameNameRows] = await connection.query(
            `
            SELECT warehouse_id
            FROM stock_balances
            WHERE LOWER(TRIM(warehouse_name)) = LOWER(TRIM(?))
              AND warehouse_id <> ?
            LIMIT 1
            `,
            [warehouseName, warehouseId]
        );

        if (sameNameRows.length) {
            return res.status(400).json({
                ok: false,
                error: "Склад з такою назвою вже існує"
            });
        }

        await connection.beginTransaction();

        await connection.query(
            `
            UPDATE stock_balances
            SET
                warehouse_name = ?,
                supplier_details = ?,
                buyer_details = ?,
                document_basis = ?,
                act_city = ?
            WHERE warehouse_id = ?
            `,
            [
                warehouseName,
                supplierDetails,
                buyerDetails,
                documentBasis,
                actCity,
                warehouseId
            ]
        );

        await connection.query(
            `
            UPDATE stock_movements
            SET warehouse_name = ?
            WHERE warehouse_id = ?
            `,
            [
                warehouseName,
                warehouseId
            ]
        );

        await connection.commit();

        return res.json({
            ok: true,
            warehouse: {
                warehouse_id: warehouseId,
                warehouse_name: warehouseName,
                supplier_details: supplierDetails,
                buyer_details: buyerDetails,
                document_basis: documentBasis,
                act_city: actCity
            }
        });

    } catch (err) {
        await connection.rollback();

        console.error("STAFF UPDATE WAREHOUSE ERROR:", err);
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
              AND NOT (
                    LOWER(TRIM(COALESCE(p.product_key, ''))) LIKE 'certificate_%'
                    OR LOWER(TRIM(COALESCE(p.display_name, ''))) LIKE '%сертифікат%'
                    OR LOWER(TRIM(COALESCE(p.category_slug, ''))) IN ('discovery', 'discovery-set')
                    OR LOWER(TRIM(COALESCE(p.product_key, ''))) LIKE '%discovery%'
                    OR LOWER(TRIM(COALESCE(p.display_name, ''))) LIKE '%discovery%'
                    OR LOWER(TRIM(COALESCE(p.display_name, ''))) LIKE '%діскавер%'
                    OR LOWER(TRIM(COALESCE(p.product_label, ''))) LIKE '%discovery%'
                    OR LOWER(TRIM(COALESCE(p.product_label, ''))) LIKE '%діскавер%'
              )
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
              AND NOT (
                    LOWER(TRIM(COALESCE(sb.product_key, ''))) LIKE 'certificate_%'
                    OR LOWER(TRIM(COALESCE(sb.product_display_name, ''))) LIKE '%сертифікат%'
                    OR LOWER(TRIM(COALESCE(sb.product_key, ''))) LIKE '%discovery%'
                    OR LOWER(TRIM(COALESCE(sb.product_display_name, ''))) LIKE '%discovery%'
                    OR LOWER(TRIM(COALESCE(sb.product_display_name, ''))) LIKE '%діскавер%'
              )
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
                product_display_name,
                quantity
            FROM stock_movements
            WHERE created_at >= ?
              AND created_at < ?
              AND movement_type IN ('transfer_in', 'transfer_return', 'sale', 'sale_discovery', 'sale_gift')
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
                product_display_name,
                quantity
            FROM stock_movements
            WHERE created_at >= ?
              AND movement_type IN ('transfer_in', 'transfer_return', 'sale', 'sale_discovery', 'sale_gift')
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
            let salesDirect = 0;
            let salesDiscovery = 0;

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
                        (
                            movementType === "sale" ||
                            movementType === "sale_discovery" ||
                            movementType === "sale_gift"
                        )
                    ) {
                        sales += quantity;

                        if (movementType === "sale_discovery") {
                            salesDiscovery += quantity;
                        } else {
                            salesDirect += quantity;
                        }
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
                    (
                        movementType === "sale" ||
                        movementType === "sale_discovery" ||
                        movementType === "sale_gift"
                    )
                ) {
                    sales += quantity;

                    if (movementType === "sale_discovery") {
                        salesDiscovery += quantity;
                    } else {
                        salesDirect += quantity;
                    }
                }
            });

            return {
                incoming,
                transferOut,
                sales,
                salesDirect,
                salesDiscovery
            };
        }

        const baseItems = stockRows
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
                    sales_quantity: Number(period.salesDirect || 0),
                    closing_quantity: closingQuantity
                };
            });

        const discoveryItems = stockRows
            .map(row => {
                const period = calcWarehouseProductMovement(row, periodMovements);

                return {
                    warehouse_id: Number(row.warehouse_id || 0),
                    warehouse_name: row.warehouse_name,
                    product_id: Number(row.product_id || 0),
                    product_key: row.product_key,
                    product_display_name: `${row.product_display_name} (у Discovery)`,
                    retail_price: Number(row.retail_price || 0),

                    opening_quantity: 0,
                    incoming_quantity: 0,
                    transfer_out_quantity: 0,
                    sales_quantity: Number(period.salesDiscovery || 0),
                    closing_quantity: 0
                };
            })
            .filter(item => Number(item.sales_quantity || 0) > 0);

        const items = [...baseItems, ...discoveryItems]
            .filter(item =>
                item.opening_quantity !== 0 ||
                item.incoming_quantity !== 0 ||
                item.transfer_out_quantity !== 0 ||
                item.sales_quantity !== 0 ||
                item.closing_quantity !== 0
            )
            .sort((a, b) => {
                const warehouseCompare =
                    Number(a.warehouse_id || 0) - Number(b.warehouse_id || 0);

                if (warehouseCompare !== 0) return warehouseCompare;

                return String(a.product_display_name || "")
                    .localeCompare(String(b.product_display_name || ""), "uk");
            });

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

/* ===================== STAFF: SALES REPORT ===================== */

app.post("/api/staff/sales-report", async (req, res) => {
    try {
        const staffId = Number(req.body.staffId || 0);
        const startDate = String(req.body.startDate || "").trim();
        const endDate = String(req.body.endDate || "").trim();

        const warehouseFiltersRaw = Array.isArray(req.body.warehouses)
            ? req.body.warehouses
                .map(item => String(item || "").trim().toLowerCase())
                .filter(Boolean)
                .filter(item => item !== "all")
            : [];

        const virtualSalesSources = warehouseFiltersRaw.filter(item =>
            item === "site" || item === "bot"
        );

        const warehouses = warehouseFiltersRaw
            .map(item => Number(item))
            .filter(id => Number.isInteger(id) && id > 0);

        const sources = Array.isArray(req.body.sources)
            ? req.body.sources
                .map(item => String(item || "").trim().toLowerCase())
                .filter(Boolean)
                .filter(item => item !== "all")
                .filter(item => item !== "site" && item !== "bot")
            : [];

        const categories = Array.isArray(req.body.categories)
            ? req.body.categories.map(item => String(item || "").trim()).filter(Boolean)
            : [];

        const byDays = Boolean(req.body.byDays);

        if (!staffId || !startDate || !endDate) {
            return res.status(400).json({
                ok: false,
                error: "Оберіть період звіту"
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
        const role = String(staff.role || "").trim();

        if (!["admin", "manager", "partner"].includes(role)) {
            return res.status(403).json({
                ok: false,
                error: "Недостатньо прав"
            });
        }

        const canViewCost = role === "admin";
        const staffWarehouseId = Number(staff.warehouse_id || 0);

        const [warehouseRows] = await db.query(
            `
            SELECT
                warehouse_id,
                MAX(warehouse_name) AS warehouse_name
            FROM stock_balances
            GROUP BY warehouse_id
            `
        );

        const warehouseMap = new Map();

        warehouseRows.forEach(row => {
            warehouseMap.set(Number(row.warehouse_id || 0), row.warehouse_name || "");
        });

        const [products] = await db.query(
            `
            SELECT
                id,
                product_key,
                display_name,
                product_label,
                price,
                cost_price,
                realization_price
            FROM products_catalog
            WHERE is_active = 1
            `
        );

        function normalizeText(value) {
            return String(value || "")
                .toLowerCase()
                .replace(/ё/g, "е")
                .replace(/[’ʼ']/g, "'")
                .replace(/\s+/g, " ")
                .trim();
        }

        const productByName = new Map();

        products.forEach(product => {
            const displayName = normalizeText(product.display_name);
            const productKey = normalizeText(product.product_key);

            if (displayName) {
                productByName.set(displayName, product);
            }

            if (productKey) {
                productByName.set(productKey, product);
            }
        });

        function findProductByName(name) {
            const cleanName = normalizeText(name);

            if (!cleanName) return null;

            if (productByName.has(cleanName)) {
                return productByName.get(cleanName);
            }

            return products.find(product => {
                const productName = normalizeText(product.display_name);
                return productName && (
                    productName.includes(cleanName) ||
                    cleanName.includes(productName)
                );
            }) || null;
        }

        function normalizeSource(value) {
            const raw = String(value || "").trim().toLowerCase();

            if (!raw || raw === "site" || raw === "bot" || raw === "staff") {
                return "empty";
            }

            return raw;
        }

        function getSourceLabel(sourceKey) {
            const labels = {
                instagram: "Instagram",
                tiktok: "TikTok",
                facebook: "Facebook",
                online_ads: "Реклама",
                recommendation: "Рекомендація",
                regular_customer: "Постійний покупець",
                empty: "Не вказано"
            };

            return labels[sourceKey] || sourceKey || "Не вказано";
        }

        function parseNumber(value) {
            const clean = String(value || "")
                .replace(/\s/g, "")
                .replace(",", ".");

            const number = Number(clean);

            return Number.isFinite(number) ? number : 0;
        }

        function extractWarehouseId(orderNote) {
            const match = String(orderNote || "").match(/ID\s*(\d+)/i);
            return match ? Number(match[1] || 0) : 0;
        }

        function parseItemsText(itemsText) {
            return String(itemsText || "")
                .split("\n")
                .map(line => line.trim())
                .filter(Boolean)
                .filter(line => !line.startsWith("↳"))
                .map(line => line.replace(/^•\s*/, "").trim())
                .map(line => {
                    const lineIsGift = normalizeText(line).includes("подарунок до акції");

                    const staffMatch = line.match(/^(.+?)\s*[×x]\s*(\d+)\s*[—-]\s*([\d.,]+)\s*грн(?:\s*=\s*([\d.,]+)\s*грн)?/i);

                    if (staffMatch) {
                        const quantity = Number(staffMatch[2] || 0);
                        const unitPrice = parseNumber(staffMatch[3]);
                        const productName = String(staffMatch[1] || "").trim();

                        return {
                            productName: lineIsGift
                                ? `${productName} (подарунок до акції)`
                                : productName,
                            productLookupName: productName,
                            isGift: lineIsGift,
                            quantity,
                            unitPrice,
                            rowTotal: parseNumber(staffMatch[4]) || unitPrice * quantity
                        };
                    }

                    const siteMatch = line.match(/^(.+?)\s*[—-]\s*([\d.,]+)\s*грн/i);

                    if (siteMatch) {
                        const unitPrice = parseNumber(siteMatch[2]);
                        const productName = String(siteMatch[1] || "").trim();

                        return {
                            productName: lineIsGift
                                ? `${productName} (подарунок до акції)`
                                : productName,
                            productLookupName: productName,
                            isGift: lineIsGift,
                            quantity: 1,
                            unitPrice,
                            rowTotal: unitPrice
                        };
                    }

                    return null;
                })
                .filter(Boolean)
                .filter(item => {
                    const name = normalizeText(item.productName);

                    return (
                        name &&
                        Number(item.quantity || 0) > 0
                    );
                });
        }

        let ordersSql = `
            SELECT
                id,
                order_id,
                source,
                customer_source,
                delivery,
                items_text,
                total_amount,
                paid_amount,
                due_amount,
                payment_type,
                order_note,
                DATE_FORMAT(created_at, '%Y-%m-%d') AS sale_date,
                created_at
            FROM orders
            WHERE created_at >= ?
              AND created_at < ?
        `;

        const ordersParams = [startAt, endExclusive];

        if (role !== "admin") {
            if (!staffWarehouseId) {
                return res.status(400).json({
                    ok: false,
                    error: "До staff-акаунта не привʼязано склад"
                });
            }

            ordersSql += `
              AND source = 'staff'
            `;
        }

        ordersSql += `
            ORDER BY created_at ASC, id ASC
        `;

        const [orders] = await db.query(ordersSql, ordersParams);

        const reportMap = new Map();
        const daySet = new Set();

         orders.forEach(order => {
            const orderSource = String(order.source || "").trim().toLowerCase();

            const orderSalesPoint =
                orderSource === "site" || orderSource === "bot"
                    ? orderSource
                    : "staff";

            const sourceKey = normalizeSource(order.customer_source);

            if (sources.length) {
                const sourceMatches =
                    sources.includes(sourceKey) ||
                    (sources.includes("empty") && sourceKey === "empty");

                if (!sourceMatches) return;
            }

            const orderWarehouseId =
                orderSalesPoint === "staff"
                    ? extractWarehouseId(order.order_note)
                    : 0;

            const orderWarehouseName =
                orderSalesPoint === "site"
                    ? "Сайт"
                    : orderSalesPoint === "bot"
                        ? "Бот"
                        : orderWarehouseId
                            ? (warehouseMap.get(orderWarehouseId) || order.delivery || "")
                            : "";

            if (role !== "admin" && orderWarehouseId !== staffWarehouseId) {
                return;
            }

            if (
                role === "admin" &&
                (warehouses.length || virtualSalesSources.length)
            ) {
                const matchesStaffWarehouse =
                    orderSalesPoint === "staff" &&
                    warehouses.includes(orderWarehouseId);

                const matchesVirtualSalesPoint =
                    virtualSalesSources.includes(orderSalesPoint);

                if (!matchesStaffWarehouse && !matchesVirtualSalesPoint) {
                    return;
                }
            }

            const reportWarehouseKey =
                orderSalesPoint === "staff"
                    ? `staff:${orderWarehouseId || 0}`
                    : orderSalesPoint;

            const parsedItems = parseItemsText(order.items_text);

            const parsedItemsGrossTotal = parsedItems.reduce(
                (sum, item) => sum + Number(item.rowTotal || 0),
                0
            );

            const orderNetTotalAmount = Number(order.total_amount || 0);

            const reportRetailRatio =
                parsedItemsGrossTotal > 0 && orderNetTotalAmount > 0
                    ? Math.min(1, orderNetTotalAmount / parsedItemsGrossTotal)
                    : 1;

            let allocatedRetailNetTotal = 0;

            parsedItems.forEach((item, itemIndex) => {
                const product = findProductByName(item.productLookupName || item.productName);

                const productLabel = String(product?.product_label || "Не визначено").trim();

                if (categories.length && !categories.includes(productLabel)) {
                    return;
                }

                const quantity = Number(item.quantity || 0);
                if (!quantity) return;

                const itemProductName = String(item.productName || "").trim();
                const itemLookupName = String(item.productLookupName || item.productName || "").trim();
                const itemProductNameLower = normalizeText(itemProductName);

                const isGiftReportItem =
                    Boolean(item.isGift) ||
                    itemProductNameLower.includes("подарунок до акції");

                const itemUnitPrice = Number(item.unitPrice);
                const itemRowTotal = Number(item.rowTotal);

                const retailPrice = isGiftReportItem
                    ? 0
                    : Number.isFinite(itemUnitPrice)
                        ? itemUnitPrice
                        : Number(product?.price || 0);

                const rowGrossTotal = isGiftReportItem
                    ? 0
                    : Number.isFinite(itemRowTotal)
                        ? itemRowTotal
                        : retailPrice * quantity;

                let rowRetailAmount = isGiftReportItem
                    ? 0
                    : Math.round(rowGrossTotal * reportRetailRatio);

                if (
                    !isGiftReportItem &&
                    reportRetailRatio < 1 &&
                    itemIndex === parsedItems.length - 1
                ) {
                    const orderNetCap = Math.max(
                        0,
                        Math.round(
                            orderNetTotalAmount > 0
                                ? Math.min(parsedItemsGrossTotal, orderNetTotalAmount)
                                : 0
                        )
                    );

                    rowRetailAmount = Math.max(
                        0,
                        orderNetCap - allocatedRetailNetTotal
                    );
                }

                allocatedRetailNetTotal += rowRetailAmount;

                const costPrice = isGiftReportItem
                    ? 0
                    : Number(product?.cost_price || 0);

                const realizationPrice = isGiftReportItem
                    ? 0
                    : Number(product?.realization_price || 0);

                const productId = Number(product?.id || 0);

                const isDiscoveryReportItem =
                    itemProductNameLower.includes("discovery") ||
                    itemProductNameLower.includes("діскавер");

                const productName = isGiftReportItem
                    ? `${product?.display_name || itemLookupName || itemProductName} (подарунок до акції)`
                    : isDiscoveryReportItem && itemProductNameLower.includes("аромати:")
                        ? itemProductName
                        : (product?.display_name || itemProductName);

                const reportProductKey =
                    isDiscoveryReportItem && itemProductNameLower.includes("аромати:")
                        ? normalizeText(productName)
                        : (productId || normalizeText(itemLookupName || productName));

                const reportSaleMode = isGiftReportItem
                    ? "gift"
                    : "sale";

                const key = [
                    reportWarehouseKey,
                    reportSaleMode,
                    reportProductKey
                ].join("|");

                if (!reportMap.has(key)) {
                    reportMap.set(key, {
                        source_key: sourceKey,
                        source: getSourceLabel(sourceKey),
                        warehouse_id: orderWarehouseId || null,
                        warehouse_name: orderWarehouseName || "",
                        product_id: productId || null,
                        product_name: productName,
                        category: productLabel,
                        quantity: 0,
                        retail_price: retailPrice,
                        retail_amount: 0,
                        cost_price: canViewCost ? costPrice : null,
                        cost_amount: canViewCost ? 0 : null,
                        realization_price: realizationPrice,
                        realization_amount: 0,
                        days: {}
                    });
                }

                const row = reportMap.get(key);

                row.quantity += quantity;
                row.retail_amount += rowRetailAmount;
                row.realization_amount += realizationPrice * quantity;

                if (canViewCost) {
                    row.cost_amount += costPrice * quantity;
                }

                if (byDays) {
                    const day = String(order.sale_date || "").slice(0, 10);

                    if (day) {
                        daySet.add(day);

                        if (!row.days[day]) {
                            row.days[day] = {
                                quantity: 0,
                                retail_amount: 0,
                                cost_amount: canViewCost ? 0 : null,
                                realization_amount: 0
                            };
                        }

                        row.days[day].quantity += quantity;
                        row.days[day].retail_amount += rowRetailAmount;
                        row.days[day].realization_amount += realizationPrice * quantity;

                        if (canViewCost) {
                            row.days[day].cost_amount += costPrice * quantity;
                        }
                    }
                }
            });
        });

        const items = Array.from(reportMap.values())
            .filter(row => Number(row.quantity || 0) > 0)
            .sort((a, b) => {
                const sourceCompare = String(a.source).localeCompare(String(b.source), "uk");
                if (sourceCompare) return sourceCompare;

                const warehouseCompare = String(a.warehouse_name || "").localeCompare(String(b.warehouse_name || ""), "uk");
                if (warehouseCompare) return warehouseCompare;

                return String(a.product_name || "").localeCompare(String(b.product_name || ""), "uk");
            });

        return res.json({
            ok: true,
            canViewCost,
            days: Array.from(daySet).sort(),
            items
        });

    } catch (err) {
        console.error("STAFF SALES REPORT ERROR:", err);

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
            orderAmount,
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
            orderAmount: orderAmount || totalAmount || "",
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

    if (!orderId) {
        console.log("MONO WEBHOOK: no reference/orderId");
        return res.sendStatus(200);
    }

    if (String(orderId).startsWith("STAFF-MONO-")) {
        const connection = await db.getConnection();

        try {
            const [pendingRows] = await connection.query(
                `
                SELECT
                    id,
                    order_id,
                    sale_payload_json,
                    status
                FROM staff_mono_pending_sales
                WHERE order_id = ?
                LIMIT 1
                `,
                [orderId]
            );

            if (!pendingRows.length) {
                console.log("STAFF MONO WEBHOOK: pending sale not found", orderId);
                return res.sendStatus(200);
            }

            const pendingSale = pendingRows[0];

            if (pendingSale.status === "completed") {
                console.log("STAFF MONO WEBHOOK: already completed", orderId);
                return res.sendStatus(200);
            }

            if (pendingSale.status !== "pending_payment") {
                console.log("STAFF MONO WEBHOOK: wrong status", orderId, pendingSale.status);
                return res.sendStatus(200);
            }

            await connection.query(
                `
                UPDATE staff_mono_pending_sales
                SET
                    status = 'paid',
                    paid_at = NOW(),
                    mono_invoice_id = COALESCE(?, mono_invoice_id)
                WHERE id = ?
                `,
                [
                    data.invoiceId || data.invoice_id || null,
                    pendingSale.id
                ]
            );

            const salePayload = JSON.parse(pendingSale.sale_payload_json || "{}");

            const staffPaymentType =
                String(salePayload.paymentType || "").trim() === "certificate_mono_qr"
                    ? "certificate_mono_qr"
                    : "mono_qr";

            const createSaleResponse = await fetch(
                "https://monal-mono-pay-production.up.railway.app/api/staff/create-sale",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        ...salePayload,
                        orderId,
                        paymentType: staffPaymentType,
                        allowOutOfStock: Boolean(salePayload.allowOutOfStock)
                    })
                }
            );

            const createSaleData = await createSaleResponse.json();

            if (!createSaleData.ok) {
                console.error("STAFF MONO WEBHOOK CREATE SALE ERROR:", createSaleData);

                await connection.query(
                    `
                    UPDATE staff_mono_pending_sales
                    SET status = 'failed'
                    WHERE id = ?
                    `,
                    [pendingSale.id]
                );

                return res.sendStatus(200);
            }

            await connection.query(
                `
                UPDATE staff_mono_pending_sales
                SET
                    status = 'completed',
                    completed_at = NOW()
                WHERE id = ?
                `,
                [pendingSale.id]
            );

            console.log("STAFF MONO SALE COMPLETED:", orderId);

            return res.sendStatus(200);

        } catch (err) {
            console.error("STAFF MONO WEBHOOK ERROR:", err);
            return res.sendStatus(200);

        } finally {
            connection.release();
        }
    }

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

const orderReportTotalAmount = Number(
    order.orderAmount !== undefined &&
    order.orderAmount !== null &&
    order.orderAmount !== ""
        ? order.orderAmount
        : order.totalAmount || 0
);
    
await appendOrderToOrdersLog({
    orderId: orderId,
    source: order.source || "site",
    totalAmount: orderReportTotalAmount,
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
            customer_source,
            buyer_name,
            buyer_phone,
            delivery,
            items_text,
            total_amount,
            paid_amount,
            due_amount,
            payment_type,
            order_note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            orderId,
            order.customerDbId || (order.source === "site" ? order.userId : null),
            order.userEmail || null,
            order.source || "site",
            order.source || "site",
            order.buyerName || "",
            order.buyerPhone || "",
            order.delivery || "",
            order.itemsText || "",
            orderReportTotalAmount,
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
