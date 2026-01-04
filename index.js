import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { google } from "googleapis";

const app = express();

/* ===================== GOOGLE SHEETS ===================== */

const credentials = JSON.parse(
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON
);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || "certificates";

/* ===================== CONFIG ===================== */

app.use(cors({
  origin: "https://monalhomecomfort-blip.github.io"
}));

app.use(express.json());

// orderId → { text, certificate }
const ORDERS = new Map();

/* ===================== HEALTH ===================== */

app.get("/", (req, res) => {
  res.send("Mono webhook is alive");
});

/* ===================== REGISTER ORDER ===================== */

app.post("/register-order", (req, res) => {
  const { orderId, text, certificate } = req.body;

  if (!orderId || !text) {
    return res.status(400).json({ error: "orderId або text відсутні" });
  }

  ORDERS.set(orderId, {
    text,
    certificate: certificate || null
  });

  res.json({ ok: true });
});

/* ===================== CREATE PAYMENT ===================== */

app.post("/create-payment", async (req, res) => {
  const { amount, orderId } = req.body;

  const monoToken = process.env.MONO_TOKEN;

  const response = await fetch(
    "https://api.monobank.ua/api/merchant/invoice/create",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Token": monoToken
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100),
        ccy: 980,
        merchantPaymInfo: {
          reference: orderId,
          destination: `Замовлення №${orderId}`
        },
        redirectUrl: "https://monalhomecomfort-blip.github.io/monal-glass-v2/payment-success.html",
        webhookUrl: "https://monal-mono-pay-production.up.railway.app/mono-webhook"
      })
    }
  );

  const data = await response.json();
  res.json({ paymentUrl: data.pageUrl });
});

/* ===================== MONO WEBHOOK ===================== */

app.post("/mono-webhook", async (req, res) => {
  const data = req.body;

  if (data.status !== "success") {
    return res.sendStatus(200);
  }

  const orderId =
    data.reference ||
    data.merchantPaymInfo?.reference;

  const order = ORDERS.get(orderId);
  if (!order) return res.sendStatus(200);

  let finalText = order.text;

  finalText += `

🔗 *Референс mono:* \`${orderId}\`
`;

  /* ===== CERTIFICATE ===== */
  if (order.certificate) {
    const certCode =
      "MONAL-" +
      Math.random().toString(36).substring(2, 6).toUpperCase() +
      "-" +
      orderId;

    const createdAt = new Date();
    const expiresAt = new Date(createdAt);
    expiresAt.setFullYear(createdAt.getFullYear() + 1);

    const format = d => d.toLocaleDateString("uk-UA");

    finalText += `

🎁 *ПОДАРУНКОВИЙ СЕРТИФІКАТ*
🔐 Код: \`${certCode}\`
💰 Номінал: ${order.certificate.nominal} грн
📅 Дійсний до: ${format(expiresAt)}
⚠️ Одноразове використання
`;

    // === GOOGLE SHEETS RECORD ===
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:G`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          certCode,
          order.certificate.nominal,
          createdAt.toISOString(),
          expiresAt.toISOString(),
          "",
          orderId,
          "active"
        ]]
      }
    });
  }

  /* ===== TELEGRAM ===== */
  const botToken = process.env.BOT_TOKEN;
  const chatId = process.env.CHAT_ID;

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: finalText,
      parse_mode: "Markdown"
    })
  });

  ORDERS.delete(orderId);
  res.sendStatus(200);
});

/* ===================== FREE ORDER (CERTIFICATE 100%) ===================== */

app.post("/send-free-order", async (req, res) => {
  const { orderId, text } = req.body;
  if (!orderId || !text) return res.sendStatus(400);

  await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.CHAT_ID,
      text: text + `

💳 *Оплата:* Сертифікат (100%)
`,
      parse_mode: "Markdown"
    })
  });

  res.json({ ok: true });
});

/* ===================== START ===================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
