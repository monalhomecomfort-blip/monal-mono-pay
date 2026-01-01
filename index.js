import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

/* ===================== CONFIG ===================== */

app.use(cors({
  origin: "https://monalhomecomfort-blip.github.io"
}));

app.use(express.json());

// тимчасове сховище замовлень до моменту успішної оплати
const ORDERS = new Map();

/* ===================== HEALTH CHECK ===================== */

app.get("/", (req, res) => {
  res.send("Mono webhook is alive");
});

/* ===================== REGISTER ORDER ===================== */
/* сайт зберігає текст замовлення ДО оплати */
app.post("/register-order", (req, res) => {
  const { orderId, text } = req.body;

  if (!orderId || !text) {
    return res.status(400).json({ error: "orderId або text відсутні" });
  }

  ORDERS.set(orderId, text);
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
          amount: Math.round(amount * 100), // копійки
          ccy: 980,
          merchantPaymInfo: {
            reference: orderId,
            destination: `Замовлення №${orderId}`
          },
          redirectUrl: "https://monalhomecomfort-blip.github.io/monal-glass-v2/index.html",
          webhookUrl: "https://monal-mono-pay-production.up.railway.app/mono-webhook"
        })
      }
    );

    const data = await response.json();

    if (!data.pageUrl) {
      console.error("Mono error:", data);
      return res.status(500).json({ error: "Mono не повернув pageUrl" });
    }

    res.json({
      paymentUrl: data.pageUrl
    });

  } catch (err) {
    console.error("Create payment error:", err);
    res.status(500).json({ error: "Помилка створення оплати" });
  }
});

/* ===================== MONO WEBHOOK ===================== */

app.post("/mono-webhook", async (req, res) => {
  try {
    const data = req.body;

    // mono може шльопати кілька статусів — реагуємо ТІЛЬКИ на success
    if (data.status !== "success") {
      return res.sendStatus(200);
    }

    const orderId = data.reference;
    const text = ORDERS.get(orderId);

    if (!text) {
      console.log("Order not found:", orderId);
      return res.sendStatus(200);
    }

    const botToken = process.env.BOT_TOKEN;
    const chatId = process.env.CHAT_ID;

    if (!botToken || !chatId) {
      console.error("BOT_TOKEN або CHAT_ID не задані");
      return res.sendStatus(200);
    }

    // надсилаємо замовлення адміну
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown"
      })
    });

    // чистимо памʼять
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
