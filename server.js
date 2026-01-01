import "dotenv/config";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

import { connectDb } from "./src/db.js";
import publicRoutes from "./src/routes/public.js";
import adminRoutes from "./src/routes/admin.js";
import webhookRoutes from "./src/routes/webhooks.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Render / reverse proxies (Render, Cloudflare, etc.)
app.set("trust proxy", 1);

// Views
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Security headers (CSP off because you’re using inline <style>/<script> in EJS)
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// Logging
app.use(morgan(process.env.NODE_ENV === "production" ? "tiny" : "dev"));

// Cookies
app.use(cookieParser());

// Rate limit (proxy-safe)
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 180,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip, // trust proxy makes this correct
  })
);

// Static files (favicon.ico, style.css, etc.)
app.use(express.static(path.join(__dirname, "public")));

// Webhooks should come BEFORE json/urlencoded if you need raw body for Stripe signatures.
// If your webhook route uses express.raw(), it MUST mount before express.json().
app.use("/webhooks", webhookRoutes);

// Body parsers (normal routes)
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

// Routes
app.use("/", publicRoutes);
app.use("/admin", adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).send("Not found.");
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("Server error.");
});

// Start
await connectDb();

const port = Number(process.env.PORT || 10000);
app.listen(port, () => console.log(`Imprev Clothing running on :${port}`));
