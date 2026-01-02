import { Router } from "express";
import crypto from "crypto";
import { Ticket } from "../models/Ticket.js";

const r = Router();

function autoReply(message) {
  const m = String(message || "").toLowerCase();

  if (m.includes("discord")) {
    return "Ask the Discord staff. Website support can’t help with Discord moderation or server issues.";
  }
  if (m.includes("disabled") || m.includes("product") || m.includes("removed")) {
    return "If a product is disabled: it was a temporary drop, a listing error, or it’s being updated. Temporary drops may return later.";
  }
  if (m.includes("refund") || m.includes("return")) {
    return "Refunds are only considered for confirmed defects or damage. If damaged, send clear photos and your receipt email.";
  }

  return "Ticket received. Staff will respond here when available.";
}

function makeAccessKey() {
  return crypto.randomBytes(18).toString("base64url"); // short but strong enough
}

function hashKey(key) {
  return crypto.createHash("sha256").update(String(key || "")).digest("hex");
}

function cookieName(publicId) {
  // cookie unique per ticket
  return `st_${String(publicId).replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function setTicketCookie(res, publicId, key) {
  res.cookie(cookieName(publicId), key, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    path: `/support/${encodeURIComponent(publicId)}`, // ✅ scoped to this ticket path
  });
}

async function validateTicketAccess(req, ticket) {
  const publicId = ticket.publicId;

  // 1) query key (first-time access / shareable link)
  const qk = String(req.query.k || "").trim();
  if (qk && ticket.accessKeyHash && hashKey(qk) === ticket.accessKeyHash) return qk;

  // 2) cookie key (normal return visits)
  const ck = String(req.cookies?.[cookieName(publicId)] || "").trim();
  if (ck && ticket.accessKeyHash && hashKey(ck) === ticket.accessKeyHash) return ck;

  return null;
}

r.get("/support", (req, res) => {
  res.render("support", { error: "", created: null });
});

r.post("/support", async (req, res) => {
  const email = String(req.body.email || "").trim().slice(0, 200);
  const subject = String(req.body.subject || "").trim().slice(0, 120);
  const message = String(req.body.message || "").trim().slice(0, 4000);

  if (!message) return res.render("support", { error: "Message required.", created: null });

  const systemReply = autoReply(message);

  const accessKey = makeAccessKey();
  const accessKeyHash = hashKey(accessKey);

  const ticket = await Ticket.create({
    email,
    subject,
    accessKeyHash,
    pageUrl: String(req.headers.referer || "").slice(0, 500),
    userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
    ip: String(req.ip || ""),
    status: "open",
    messages: [
      { from: "user", text: message },
      { from: "system", text: systemReply },
    ],
  });

  // ✅ set cookie so the creator stays logged into that ticket
  setTicketCookie(res, ticket.publicId, accessKey);

  // ✅ shareable / reopen link (works even in a different browser/device)
  const link = `/support/${encodeURIComponent(ticket.publicId)}?k=${encodeURIComponent(accessKey)}`;

  res.render("support", {
    error: "",
    created: { publicId: ticket.publicId, systemReply, link },
  });
});

r.get("/support/:publicId", async (req, res) => {
  const publicId = String(req.params.publicId || "").trim();
  const ticket = await Ticket.findOne({ publicId }).lean();
  if (!ticket) return res.status(404).send("Not found");

  const okKey = await validateTicketAccess(req, ticket);
  if (!okKey) {
    // ✅ no annoying alert, just a clean message
    return res.status(403).send("Support access denied. Use the original ticket link (with ?k=...) to reopen.");
  }

  // ✅ refresh cookie (keeps it alive)
  setTicketCookie(res, ticket.publicId, okKey);

  res.render("support_thread", { ticket });
});

export default r;
