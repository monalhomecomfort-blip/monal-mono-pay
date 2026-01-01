import express from "express";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Mono webhook is alive");
});

app.post("/mono-webhook", (req, res) => {
  console.log("MONO WEBHOOK:", req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});

app.post("/create-payment", async (req, res) => {
  const { amount, orderId } = req.body;

  if (!amount || !orderId) {
    return res.status(400).json({ error: "amount або orderId відсутні" });
  }

  // ТУТ ПОКИ ФЕЙК (щоб перевірити ланцюжок)
  // Замість mono ми повертаємо заглушку
  res.json({
    checkoutUrl: `https://example.com/pay?order=${orderId}&sum=${amount}`
  });
});
