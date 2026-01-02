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
app.disable("x-powered-by");

// Views
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Logging
app.use(morgan(process.env.NODE_ENV === "production" ? "tiny" : "dev"));

// Timeouts (basic slowloris resistance)
app.use((req, res, next) => {
  req.setTimeout(15_000);
  res.setTimeout(15_000);
  next();
});

// Force HTTPS in production (via proxy header)
function enforceHttps(req, res, next) {
  if (process.env.NODE_ENV !== "production") return next();
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (proto && proto !== "https") {
    const host = req.headers.host;
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }
  next();
}
app.use(enforceHttps);

// Security headers
// CSP allows inline because your EJS uses inline <style>/<script>.
// COEP is OFF because it breaks Cloudinary images. CORP is cross-origin to allow them.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        imgSrc: ["'self'", "data:", "https:"], // allow Cloudinary + https images
        connectSrc: ["'self'", "https:"],
        fontSrc: ["'self'", "data:", "https:"],
        styleSrc: ["'self'", "'unsafe-inline'", "https:"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https:"],
      },
    },
    crossOriginEmbedderPolicy: false, // ✅ DO NOT break external images
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "cross-origin" }, // ✅ allow external resources
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  })
);

// HSTS (only in production)
if (process.env.NODE_ENV === "production") {
  app.use(
    helmet.hsts({
      maxAge: 15552000, // 180 days
      includeSubDomains: true,
      preload: false,
    })
  );
}

// Cookies
app.use(cookieParser());

// Rate limits (global + burst + route-specific)
const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});

const burstLimiter = rateLimit({
  windowMs: 10_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});

const checkoutLimiter = rateLimit({
  windowMs: 60_000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});

app.use(globalLimiter);
app.use(burstLimiter);

// Cheap garbage filter
app.use((req, res, next) => {
  if ((req.originalUrl || "").length > 2000) return res.status(414).send("URI too long.");
  next();
});

// Static files (favicon.ico, style.css, etc.)
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));

// Origin/Referer guard (blocks cross-site POSTs). Webhooks exempt.
function originGuard(req, res, next) {
  const m = req.method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  if (req.originalUrl.startsWith("/webhooks")) return next();

  const host = String(req.headers.host || "");
  const origin = String(req.headers.origin || "");
  const referer = String(req.headers.referer || "");

  const originOk = !origin || origin.includes(`://${host}`);
  const refererOk = !referer || referer.includes(`://${host}`);

  if (!originOk || !refererOk) return res.status(403).send("Blocked.");
  next();
}
app.use(originGuard);

// Webhooks BEFORE body parsers (Stripe raw body signature verification)
app.use("/webhooks", webhookRoutes);

// Body parsers
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

// API docs route
app.get("/api/docs", (req, res) => res.render("api/docs"));
app.get("/api", (req, res) => res.redirect("/api/docs"));

// Route-level limits
app.use("/admin/login", adminLoginLimiter);
app.use("/checkout", checkoutLimiter);

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
