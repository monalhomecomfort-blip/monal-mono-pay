import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

app.use(cors({
  origin: "https://monalhomecomfort-blip.github.io"
}));

app.use(express.json());

/* ===== health check ===== */
app.get("/", (req, res) => {
  res.send("Mono webhook is alive");
});

/* ===== CREATE MONO PAYMENT ===== */
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

    const response = await fetch("https://api.monobank.ua/api/merchant/invoice/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Token": monoToken
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100), // mono працює в копійках
        ccy: 980,
        merchantPaymInfo: {
          reference: orderId,
          destination: `Замовлення №${orderId}`
        },
        redirectUrl: "https://monalhomecomfort-blip.github.io/cart.html",
        webhookUrl: "https://monal-mono-pay-production.up.railway.app/mono-webhook"
      })
    });

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

/* ===== MONO WEBHOOK ===== */
app.post("/mono-webhook", (req, res) => {
  console.log("MONO WEBHOOK:", req.body);

  // ❗ ТУТ ПІЗНІШЕ:
  // перевірка status === "success"
  // і виклик sendOrderToTelegram через окремий endpoint

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
