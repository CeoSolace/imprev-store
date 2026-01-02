import crypto from "crypto";
import { Ticket } from "../models/Ticket.js";
import { verifyJwt } from "../middleware/jwt.js";

function parseCookie(header) {
  const out = {};
  const s = String(header || "");
  s.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function cookieName(publicId) {
  return `st_${String(publicId).replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function hashKey(key) {
  return crypto.createHash("sha256").update(String(key || "")).digest("hex");
}

function getAdminPayload(socket) {
  const cookies = parseCookie(socket.handshake.headers.cookie || "");
  const token = cookies.admin_token;
  if (!token) return null;
  return verifyJwt(token);
}

export function attachSupportSockets(io) {
  io.on("connection", (socket) => {
    socket.on("ticket:join", async ({ publicId }) => {
      publicId = String(publicId || "").trim();
      if (!publicId) return;

      const ticket = await Ticket.findOne({ publicId }).lean();
      if (!ticket) return;

      const admin = getAdminPayload(socket);

      // user auth via cookie (set by /support/:id route)
      const cookies = parseCookie(socket.handshake.headers.cookie || "");
      const userKey = cookies[cookieName(publicId)];

      const userOk =
        !!userKey &&
        !!ticket.accessKeyHash &&
        hashKey(userKey) === ticket.accessKeyHash;

      // allow join if admin OR authorized user
      if (!admin && !userOk) {
        socket.emit("ticket:authfail", { message: "Access denied. Use your ticket link to reopen." });
        return;
      }

      socket.join(`ticket:${publicId}`);

      socket.emit("ticket:init", {
        publicId: ticket.publicId,
        status: ticket.status,
        messages: (ticket.messages || []).map((m) => ({
          from: m.from,
          text: m.text,
          ts: m.ts || m.createdAt || new Date(),
        })),
      });
    });

    socket.on("ticket:send", async ({ publicId, text, role }) => {
      publicId = String(publicId || "").trim();
      text = String(text || "").trim().slice(0, 4000);
      role = role === "admin" ? "admin" : "user";
      if (!publicId || !text) return;

      const ticket = await Ticket.findOne({ publicId });
      if (!ticket) return;

      const admin = getAdminPayload(socket);

      if (role === "admin") {
        if (!admin) return; // no admin cookie, no admin messages
      } else {
        // user auth via cookie
        const cookies = parseCookie(socket.handshake.headers.cookie || "");
        const userKey = cookies[cookieName(publicId)];
        const userOk =
          !!userKey &&
          !!ticket.accessKeyHash &&
          hashKey(userKey) === ticket.accessKeyHash;

        if (!userOk) return;
      }

      // closed ticket: user message reopens
      if (ticket.status === "closed" && role === "user") ticket.status = "open";

      const msg = { from: role, text, ts: new Date() };
      ticket.messages.push(msg);
      if (role === "admin") ticket.lastAdminAt = new Date();
      await ticket.save();

      io.to(`ticket:${publicId}`).emit("ticket:new", msg);
      io.to(`ticket:${publicId}`).emit("ticket:status", { status: ticket.status });
    });
  });
}
