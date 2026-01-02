import "dotenv/config";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";

import { Server as IOServer } from "socket.io";

import { connectDb } from "./src/db.js";
import publicRoutes from "./src/routes/public.js";
import adminRoutes from "./src/routes/admin.js";
import webhookRoutes from "./src/routes/webhooks.js";

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
        connectSrc: ["'self'", "https:"], // socket.io uses same-origin
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
app.use((req, res) => res.status(404).send("Not found."));

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("Server error.");
});

// ---- HTTP + Socket.IO ----
const server = http.createServer(app);

const io = new IOServer(server, {
  path: "/socket.io",
  transports: ["websocket"],
  cors: { origin: true, credentials: true },
});

// cookie helper for socket handshake
function parseCookie(header) {
  const out = {};
  String(header || "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const i = pair.indexOf("=");
      if (i === -1) return;
      const k = pair.slice(0, i).trim();
      const v = decodeURIComponent(pair.slice(i + 1).trim());
      out[k] = v;
    });
  return out;
}

io.use((socket, next) => {
  const cookies = parseCookie(socket.handshake.headers.cookie);
  const token = cookies.admin_token;
  const payload = token ? verifyJwt(token) : null;
  socket.data.isAdmin = !!payload;
  socket.data.adminEmail = payload?.email || "";
  next();
});

// Live support
io.on("connection", (socket) => {
  socket.on("ticket:join", async ({ publicId, role }) => {
    try {
      publicId = String(publicId || "").trim().toUpperCase();
      role = String(role || "user").trim();

      if (!publicId) return socket.emit("ticket:error", "Missing ticket ID.");

      const ticket = await Ticket.findOne({ publicId }).lean();
      if (!ticket) return socket.emit("ticket:error", "Ticket not found.");

      if (role === "admin" && !socket.data.isAdmin) {
        return socket.emit("ticket:error", "Admin auth required.");
      }

      socket.join(publicId);
      socket.emit("ticket:status", ticket.status);

      // send full history
      socket.emit(
        "ticket:history",
        (ticket.messages || []).map((m) => ({
          from: m.from,
          text: m.text,
          ts: m.createdAt || ticket.createdAt,
        }))
      );
    } catch (e) {
      console.error("ticket:join error", e);
      socket.emit("ticket:error", "Join failed.");
    }
  });

  socket.on("ticket:send", async ({ publicId, text, role }) => {
    try {
      publicId = String(publicId || "").trim().toUpperCase();
      text = String(text || "").trim().slice(0, 4000);
      role = String(role || "user").trim();

      if (!publicId || !text) return;

      const ticket = await Ticket.findOne({ publicId });
      if (!ticket) return;

      if (ticket.status === "closed" && role !== "admin") return;

      if (role === "admin") {
        if (!socket.data.isAdmin) return;
        ticket.messages.push({ from: "admin", text });
        ticket.lastAdminAt = new Date();
      } else {
        ticket.messages.push({ from: "user", text });
        // if user replies to closed, reopen automatically
        if (ticket.status === "closed") ticket.status = "open";
      }

      await ticket.save();

      io.to(publicId).emit("ticket:message", {
        from: role === "admin" ? "admin" : "user",
        text,
        ts: Date.now(),
      });

      io.to(publicId).emit("ticket:status", ticket.status);
    } catch (e) {
      console.error("ticket:send error", e);
      socket.emit("ticket:error", "Send failed.");
    }
  });

  socket.on("ticket:close", async ({ publicId }) => {
    try {
      if (!socket.data.isAdmin) return;
      publicId = String(publicId || "").trim().toUpperCase();
      const ticket = await Ticket.findOne({ publicId });
      if (!ticket) return;

      ticket.status = "closed";
      await ticket.save();
      io.to(publicId).emit("ticket:status", "closed");
      io.to(publicId).emit("ticket:message", { from: "system", text: "Ticket closed by staff.", ts: Date.now() });
    } catch (e) {
      console.error("ticket:close error", e);
    }
  });

  socket.on("ticket:reopen", async ({ publicId }) => {
    try {
      if (!socket.data.isAdmin) return;
      publicId = String(publicId || "").trim().toUpperCase();
      const ticket = await Ticket.findOne({ publicId });
      if (!ticket) return;

      ticket.status = "open";
      await ticket.save();
      io.to(publicId).emit("ticket:status", "open");
      io.to(publicId).emit("ticket:message", { from: "system", text: "Ticket reopened by staff.", ts: Date.now() });
    } catch (e) {
      console.error("ticket:reopen error", e);
    }
  });
});

// Start
await connectDb();
const port = Number(process.env.PORT || 10000);
server.listen(port, () => console.log(`Imprev Clothing running on :${port}`));
