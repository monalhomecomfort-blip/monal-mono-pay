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
