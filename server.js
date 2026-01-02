import "dotenv/config";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { Server as SocketIOServer } from "socket.io";

import { connectDb } from "./src/db.js";
import publicRoutes from "./src/routes/public.js";
import adminRoutes from "./src/routes/admin.js";
import webhookRoutes from "./src/routes/webhooks.js";
import supportRoutes from "./src/routes/support.js";

import { verifyJwt } from "./src/middleware/jwt.js";
import { Ticket } from "./src/models/Ticket.js";

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

// Timeouts
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
        connectSrc: ["'self'", "https:", "wss:"], // ✅ allow websockets
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

// HSTS (only in production)
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

const supportLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
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

// Static files
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

// Webhooks BEFORE body parsers
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
app.use("/support", supportLimiter);

// Routes
app.use("/", publicRoutes);
app.use("/support", supportRoutes);
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

// ---- SOCKET.IO REALTIME SUPPORT ----
const server = http.createServer(app);

const io = new SocketIOServer(server, {
  path: "/socket.io",
  cors: { origin: true, credentials: true },
});

function safeText(x) {
  return String(x || "").replace(/\s+/g, " ").trim().slice(0, 2000);
}

io.on("connection", (socket) => {
  // Client must call: socket.emit("join_ticket", { publicId, role, token? })
  socket.on("join_ticket", async (payload, cb) => {
    try {
      const publicId = String(payload?.publicId || "").trim();
      const role = String(payload?.role || "").trim(); // "user" | "admin"
      if (!publicId) return cb?.({ ok: false, error: "Missing ticket id" });
      if (role !== "user" && role !== "admin") return cb?.({ ok: false, error: "Bad role" });

      // Admin auth via cookie admin_token
      if (role === "admin") {
        const cookie = String(socket.handshake.headers.cookie || "");
        const match = cookie.match(/(?:^|;\s*)admin_token=([^;]+)/);
        if (!match) return cb?.({ ok: false, error: "No admin auth" });

        const token = decodeURIComponent(match[1]);
        const decoded = verifyJwt(token);
        if (!decoded?.email) return cb?.({ ok: false, error: "Bad admin token" });
      }

      // User auth via ticketToken cookie set when ticket is created/opened
      if (role === "user") {
        const cookie = String(socket.handshake.headers.cookie || "");
        const match = cookie.match(/(?:^|;\s*)ticket_token=([^;]+)/);
        if (!match) return cb?.({ ok: false, error: "No ticket token" });

        const token = decodeURIComponent(match[1]);
        const decoded = verifyJwt(token);
        if (!decoded?.ticket || decoded.ticket !== publicId) return cb?.({ ok: false, error: "Bad ticket token" });
      }

      const ticket = await Ticket.findOne({ publicId }).lean();
      if (!ticket) return cb?.({ ok: false, error: "Ticket not found" });

      socket.data.publicId = publicId;
      socket.data.role = role;

      socket.join(`ticket:${publicId}`);
      cb?.({ ok: true });
    } catch (e) {
      console.error("join_ticket error:", e);
      cb?.({ ok: false, error: "Join failed" });
    }
  });

  socket.on("send_message", async (payload, cb) => {
    try {
      const publicId = socket.data.publicId;
      const role = socket.data.role;
      if (!publicId || !role) return cb?.({ ok: false, error: "Not joined" });

      const text = safeText(payload?.text);
      if (!text) return cb?.({ ok: false, error: "Empty" });

      const msg = {
        by: role,
        text,
        ts: new Date(),
      };

      const t = await Ticket.findOne({ publicId });
      if (!t) return cb?.({ ok: false, error: "Missing ticket" });

      // If closed and user replies, reopen
      if (t.status === "closed" && role === "user") t.status = "open";

      t.messages.push(msg);
      t.updatedAt = new Date();
      await t.save();

      io.to(`ticket:${publicId}`).emit("message", {
        by: msg.by,
        text: msg.text,
        ts: msg.ts,
      });

      cb?.({ ok: true });
    } catch (e) {
      console.error("send_message error:", e);
      cb?.({ ok: false, error: "Send failed" });
    }
  });
});

// Start
await connectDb();

const port = Number(process.env.PORT || 10000);
server.listen(port, () => console.log(`Imprev Clothing running on :${port}`));
