import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

/* ===================== CONFIG ===================== */

app.use(cors({
  origin: "https://monalhomecomfort-blip.github.io"
}));

app.use(express.json());

// Тимчасове сховище замовлень ДО оплати
// orderId → { text, certificate }
const ORDERS = new Map();

/* ===================== HEALTH CHECK ===================== */

app.get("/", (req, res) => {
  res.send("Mono webhook is alive");
});

/* ===================== REGISTER ORDER ===================== */
/*
  Сайт шле:
  {
    orderId,
    text,
    certificate: { nominal } | null
  }
*/
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

/* ===================== CREATE MONO PAYMENT ===================== */

app.post("/create-payment", async (req, res) => {
  try {
    const { amount, orderId } = req.body;

    if (!amount || !orderId) {
      return res.status(400).json({ error: "amount або orderId відсутні" });
    }

    const monoToken = process.env.MONO_TOKEN;
    if (!monoToken) {
      return res.status(500).json({ error: "MONO_TOKEN не заданий" });
    }

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

    if (!data.pageUrl) {
      console.error("Mono error:", data);
      return res.status(500).json({ error: "Mono не повернув pageUrl" });
    }

    res.json({ paymentUrl: data.pageUrl });

  } catch (err) {
    console.error("Create payment error:", err);
    res.status(500).json({ error: "Помилка створення оплати" });
  }
});

/* ===================== MONO WEBHOOK ===================== */

app.post("/mono-webhook", async (req, res) => {
  try {
    const data = req.body;

    // Реагуємо ТІЛЬКИ на успішну оплату
    if (data.status !== "success") {
      return res.sendStatus(200);
    }

    const orderId =
      data.reference ||
      data.merchantPaymInfo?.reference;

    if (!orderId) {
      console.log("No order reference in webhook");
      return res.sendStatus(200);
    }

    const order = ORDERS.get(orderId);

    if (!order) {
      console.log("Order not found:", orderId);
      return res.sendStatus(200);
    }

    let finalText = order.text;

    /* ===== GENERATE CERTIFICATE IF EXISTS ===== */
    if (order.certificate) {
      const certCode =
        "MONAL-" +
        Math.random().toString(36).substring(2, 6).toUpperCase() +
        "-" +
        orderId;

      const createdAt = new Date();
      const expiresAt = new Date(createdAt);
      expiresAt.setFullYear(createdAt.getFullYear() + 1);

      const formatDate = d => d.toLocaleDateString("uk-UA");

      finalText += `

🎁 *ПОДАРУНКОВИЙ СЕРТИФІКАТ*
🔐 Код: \`${certCode}\`
💰 Номінал: ${order.certificate.nominal} грн
📅 Дійсний до: ${formatDate(expiresAt)}
⚠️ Одноразове використання
`;
    }

    const botToken = process.env.BOT_TOKEN;
    const chatId = process.env.CHAT_ID;

    if (!botToken || !chatId) {
      console.error("BOT_TOKEN або CHAT_ID не задані");
      return res.sendStatus(200);
    }

    // Надсилаємо адміну
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: finalText,
        parse_mode: "Markdown"
      })
    });

    // Чистимо замовлення
    ORDERS.delete(orderId);

    res.sendStatus(200);

  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(200);
  }
});

/* ===================== START SERVER ===================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
