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

/* =========================
   Proxy + app basics
========================= */
app.set("trust proxy", 1); // Render/Cloudflare etc.
app.disable("x-powered-by");

/* =========================
   Views
========================= */
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

/* =========================
   Logging
========================= */
app.use(morgan(process.env.NODE_ENV === "production" ? "tiny" : "dev"));

/* =========================
   Timeouts (basic slowloris resistance)
========================= */
app.use((req, res, next) => {
  req.setTimeout(15_000);
  res.setTimeout(15_000);
  next();
});

/* =========================
   Force HTTPS (prod only)
========================= */
function enforceHttps(req, res, next) {
  if (process.env.NODE_ENV !== "production") return next();

  const proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();

  if (proto && proto !== "https") {
    const host =
      String(req.headers["x-forwarded-host"] || req.headers.host || "")
        .split(",")[0]
        .trim();

    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }

  next();
}
app.use(enforceHttps);

/* =========================
   Security headers
   - CSP allows inline because your EJS uses inline <style>/<script>
   - COEP off because it breaks external images (cloudinary/etc)
========================= */
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
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https:"],
        fontSrc: ["'self'", "data:", "https:"],
        styleSrc: ["'self'", "'unsafe-inline'", "https:"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https:"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  })
);

if (process.env.NODE_ENV === "production") {
  app.use(
    helmet.hsts({
      maxAge: 15552000, // 180 days
      includeSubDomains: true,
      preload: false,
    })
  );
}

/* =========================
   Cookies
========================= */
app.use(cookieParser());

/* =========================
   Rate limiting
========================= */
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

/* =========================
   Basic junk filter
========================= */
app.use((req, res, next) => {
  if ((req.originalUrl || "").length > 2000) return res.status(414).send("URI too long.");
  next();
});

/* =========================
   Static files
   - Put favicon.ico in /public/favicon.ico
========================= */
app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: "1h",
    etag: true,
  })
);

/* =========================
   Origin/Referer guard (FIXED)
   - Your old version broke when host/proxy headers didn’t match exactly.
   - This one parses URLs properly and accepts forwarded hosts + BASE_URL host.
========================= */
function safeHostFromReq(req) {
  return String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
}

function safeHostFromEnv() {
  const base = String(process.env.BASE_URL || "").trim();
  if (!base) return null;
  try {
    return new URL(base).host.toLowerCase(); // host includes port if present
  } catch {
    return null;
  }
}

function hostFromHeaderUrl(h) {
  const s = String(h || "").trim();
  if (!s) return null;
  try {
    return new URL(s).host.toLowerCase();
  } catch {
    // Sometimes referer/origin is garbage. Treat as invalid.
    return "__invalid__";
  }
}

function originGuard(req, res, next) {
  const m = req.method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();

  // Webhooks must not be blocked
  if (req.originalUrl.startsWith("/webhooks")) return next();

  const reqHost = safeHostFromReq(req);          // actual host we’re serving
  const envHost = safeHostFromEnv();             // BASE_URL host
  const allowedHosts = new Set([reqHost]);
  if (envHost) allowedHosts.add(envHost);

  const originHost = hostFromHeaderUrl(req.headers.origin);
  const refererHost = hostFromHeaderUrl(req.headers.referer);

  // If header is missing, allow (some clients/proxies omit)
  // If header exists but is invalid or not allowed, block.
  if (originHost && originHost !== "__invalid__" && !allowedHosts.has(originHost)) {
    return res.status(403).send("Blocked.");
  }
  if (refererHost && refererHost !== "__invalid__" && !allowedHosts.has(refererHost)) {
    return res.status(403).send("Blocked.");
  }
  if (originHost === "__invalid__" || refererHost === "__invalid__") {
    return res.status(403).send("Blocked.");
  }

  next();
}
app.use(originGuard);

/* =========================
   Webhooks BEFORE body parsers
   (Stripe signature verification needs raw body in webhookRoutes)
========================= */
app.use("/webhooks", webhookRoutes);

/* =========================
   Body parsers (normal routes)
========================= */
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

/* =========================
   API docs
========================= */
app.get("/api/docs", (req, res) => res.render("api/docs"));
app.get("/api", (req, res) => res.redirect("/api/docs"));

/* =========================
   Route-level limits
========================= */
app.use("/admin/login", adminLoginLimiter);
app.use("/checkout", checkoutLimiter);

/* =========================
   App routes
========================= */
app.use("/", publicRoutes);
app.use("/admin", adminRoutes);

/* =========================
   404 + error handler
========================= */
app.use((req, res) => {
  res.status(404).send("Not found.");
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("Server error.");
});

/* =========================
   Start
========================= */
await connectDb();

const port = Number(process.env.PORT || 10000);
app.listen(port, () => console.log(`Imprev Clothing running on :${port}`));
