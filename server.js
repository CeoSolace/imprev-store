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
import storeRoutes from "./src/routes/stores.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(morgan(process.env.NODE_ENV === "production" ? "tiny" : "dev"));

app.use((req, res, next) => {
  req.setTimeout(15_000);
  res.setTimeout(15_000);
  next();
});

function enforceHttps(req, res, next) {
  if (process.env.NODE_ENV !== "production") return next();

  const proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();

  if (proto && proto !== "https") {
    const host = req.headers.host;
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }

  next();
}

app.use(enforceHttps);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        formAction: ["'self'", "https://checkout.stripe.com"],
        connectSrc: ["'self'", "https:"],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'", "data:", "https:"],
        styleSrc: ["'self'", "'unsafe-inline'", "https:"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://js.stripe.com"],
        frameSrc: ["'self'", "https://checkout.stripe.com"]
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" }
  })
);

if (process.env.NODE_ENV === "production") {
  app.use(
    helmet.hsts({
      maxAge: 15552000,
      includeSubDomains: true,
      preload: false
    })
  );
}

app.use(cookieParser());

const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip
});

const burstLimiter = rateLimit({
  windowMs: 10_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip
});

const checkoutLimiter = rateLimit({
  windowMs: 60_000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip
});

app.use(globalLimiter);
app.use(burstLimiter);

app.use((req, res, next) => {
  if ((req.originalUrl || "").length > 2000) {
    return res.status(414).send("URI too long.");
  }

  next();
});

app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1h",
  etag: true
}));

function originGuard(req, res, next) {
  const m = req.method.toUpperCase();

  if (m === "GET" || m === "HEAD" || m === "OPTIONS") {
    return next();
  }

  if (req.originalUrl.startsWith("/webhooks")) {
    return next();
  }

  const host = String(req.headers.host || "");
  const origin = String(req.headers.origin || "");
  const referer = String(req.headers.referer || "");

  const originOk = !origin || origin.includes(`://${host}`);
  const refererOk = !referer || referer.includes(`://${host}`);

  if (!originOk || !refererOk) {
    return res.status(403).send("Blocked.");
  }

  next();
}

app.use(originGuard);

app.use("/webhooks", webhookRoutes);

app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

app.get("/api/docs", (req, res) => res.render("api/docs"));
app.get("/api", (req, res) => res.redirect("/api/docs"));

app.use("/admin/login", adminLoginLimiter);
app.use("/checkout", checkoutLimiter);

app.use("/", publicRoutes);
app.use("/stores", storeRoutes);
app.use("/admin", adminRoutes);

app.use((req, res) => res.status(404).send("Not found."));

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).send("Server error.");
});

await connectDb();

const port = Number(process.env.PORT || 10000);
app.listen(port, () => {
  console.log(`Imprev running on :${port}`);
});
