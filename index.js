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
                    "",          // N: Примітки
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

app.use(express.json());

// orderId → { text, certificates }
const ORDERS = new Map();

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
            "INSERT INTO customers (name, email, password_hash, total_spent, discount) VALUES (?, ?, ?, 0, 3)",
            [name, email, hash]
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
                discount: user.discount,
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
            "SELECT id, name, email, phone, birthday, gender, address, discount, total_spent FROM customers WHERE id = ?",
            [userId]
        );

        if (!rows.length) {
            return res.status(404).json({ error: "user not found" });
        }

        res.json(rows[0]);

    } catch (err) {

        console.error("GET USER ERROR:", err);
        res.status(500).json({ error: "server error" });

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
        itemsText
    }));

    ORDERS.set(orderId, {
        // для Telegram
        text,

        // 🔹 ДЖЕРЕЛО ЗАМОВЛЕННЯ
        source: req.body.source || "site",
        userId: req.body.userId || null,
        userEmail: req.body.userEmail || null,
        
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
        `💳 ${order.paymentLabel || "—"}\n`;

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
            ? `👤 *Персональна знижка:* ${personalDiscount} грн\n`
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
            payment_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            order.paymentLabel || ""
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
            "SELECT total_spent FROM customers WHERE id = ?",
            [uid]
        );

        if (rows.length) {

            const spent = Number(rows[0].total_spent);

            let newDiscount = 3;

            if (spent >= 15000) newDiscount = 15;
            else if (spent >= 10000) newDiscount = 10;
            else if (spent >= 8000) newDiscount = 7;
            else if (spent >= 5000) newDiscount = 5;
            else newDiscount = 3;

            await db.query(
                "UPDATE customers SET discount = ? WHERE id = ?",
                [newDiscount, uid]
            );

        }

    } catch (err) {

        console.error("MYSQL LOYALTY UPDATE ERROR:", err);

    }

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
