import express from "express";
import cors from "cors";

const app = express();

app.use(cors({
  origin: "https://monalhomecomfort-blip.github.io"
}));

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Mono webhook is alive");
});

app.post("/mono-webhook", (req, res) => {
  console.log("MONO WEBHOOK:", req.body);
  res.sendStatus(200);
});

app.post("/create-payment", async (req, res) => {
  const { amount, orderId } = req.body;

  if (!amount || !orderId) {
    return res.status(400).json({ error: "amount або orderId відсутні" });
  }

  // ПОКИ ЗАГЛУШКА (пізніше замінимо на реальний mono)
  res.json({
    paymentUrl: `https://example.com/pay?order=${orderId}&sum=${amount}`
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
