// web-server.cjs (CommonJS) - Render Web Service health + simple routes
// Start Command: node web-server.cjs
// Build Command: npm install

const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.status(200).send("elmas-web OK");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, service: "elmas-web", ts: Date.now() });
});

app.listen(PORT, () => {
  console.log("🌐 Web server running on port", PORT);
});
