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

// Reverse proxies (Render/Cloudflare)
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Views
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Logging
app.use(morgan(process.env.NODE_ENV === "production" ? "tiny" : "dev"));

// Slowloris-ish timeouts
app.use((req, res, next) => {
  req.setTimeout(15_000);
  res.setTimeout(15_000);
  next();
});

// Force HTTPS in production (proxy-aware)
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
// IMPORTANT: Stripe checkout requires allowing stripe.com + js.stripe.com + checkout.stripe.com
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],

        // Allow posting to ourselves AND Stripe (your form posts to /checkout, then redirect happens)
        formAction: ["'self'", "https://checkout.stripe.com"],

        // If any frontend fetches happen later (fine as-is)
        connectSrc: ["'self'", "https:"],

        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'", "data:", "https:"],

        // You use inline styles/scripts in EJS, so unsafe-inline stays
        styleSrc: ["'self'", "'unsafe-inline'", "https:"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://js.stripe.com"],

        // Optional but safe
        frameSrc: ["'self'", "https://checkout.stripe.com"],
      },
    },

    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  })
);

// HSTS
if (process.env.NODE_ENV === "production") {
  app.use(
    helmet.hsts({
      maxAge: 15552000,
      includeSubDomains: true,
      preload: false,
    })
  );
}

// Cookies
app.use(cookieParser());

// Rate limits
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

// Garbage filter
app.use((req, res, next) => {
  if ((req.originalUrl || "").length > 2000) return res.status(414).send("URI too long.");
  next();
});

// Static
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));

// Origin/Referer guard
// NOTE: This blocks cross-site POSTs, but allows normal browser POSTs.
// If you deploy behind weird proxy setups, Origin header might be missing sometimes: that's allowed.
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

// Webhooks before JSON (Stripe signature)
app.use("/webhooks", webhookRoutes);

// Body parsers
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

// API docs
app.get("/api/docs", (req, res) => res.render("api/docs"));
app.get("/api", (req, res) => res.redirect("/api/docs"));

// Route-level limits
app.use("/admin/login", adminLoginLimiter);
app.use("/checkout", checkoutLimiter);

// Routes
app.use("/", publicRoutes);
app.use("/admin", adminRoutes);

// 404
app.use((req, res) => res.status(404).send("Not found."));

// Error handler (don’t swallow the real error)
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).send("Server error.");
});

// Start
await connectDb();

const port = Number(process.env.PORT || 10000);
app.listen(port, () => console.log(`Imprev Clothing running on :${port}`));
