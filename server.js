const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const rutasLogin = require("./login/backend/rutasLogin");
const PORT = process.env.PORT || 3000;

const app = express();

// =========================
// CORS CORRECTO
// =========================
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors());

// =========================
// JSON
// =========================
app.use(express.json());

// =========================
// FRONTEND
// =========================
app.use(
  express.static(
    path.join(__dirname, "login/frontend")
  )
);

// =========================
// RUTA LOGIN HTML
// =========================
app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "login/frontend/login.html")
  );
});

// =========================
// API
// =========================
app.use("/api", rutasLogin);

// =========================
// MONGODB
// =========================
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB conectado");

    app.listen(PORT, () => {
        console.log(`Servidor corriendo en puerto ${PORT}`);
    });
  })
  .catch((error) => {
    console.log(error);
  });
