import { Ticket } from "../models/Ticket.js";
import { verifyJwt } from "../middleware/jwt.js";

function isAdminFromCookie(socket) {
  const cookie = String(socket.handshake.headers.cookie || "");
  const m = cookie.match(/(?:^|;\s*)admin_token=([^;]+)/);
  if (!m) return null;
  const token = decodeURIComponent(m[1]);
  return verifyJwt(token); // returns payload or null
}

export function attachSupportSockets(io) {
  io.on("connection", (socket) => {
    socket.on("ticket:join", async ({ publicId }) => {
      publicId = String(publicId || "").trim();
      if (!publicId) return;

      const ticket = await Ticket.findOne({ publicId }).lean();
      if (!ticket) return;

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

      // only admins can post as admin
      if (role === "admin") {
        const adminPayload = isAdminFromCookie(socket);
        if (!adminPayload) return; // silently ignore
      }

      // If closed, users posting reopens it. Admin can post without reopening.
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
