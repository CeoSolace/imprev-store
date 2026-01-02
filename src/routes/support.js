import { Router } from "express";
import crypto from "crypto";
import { Ticket } from "../models/Ticket.js";
import { signJwt } from "../middleware/jwt.js";

const r = Router();

function makeId() {
  // 8 digits-ish, readable
  return String(Math.floor(10000000 + Math.random() * 90000000));
}

function autoReply(message) {
  const m = String(message || "").toLowerCase();

  if (m.includes("discord")) {
    return "Discord issues: ask the staff of the Discord. Website support can’t help with Discord moderation/server problems.";
  }
  if (m.includes("disabled") || m.includes("product") && m.includes("gone")) {
    return "If a product is disabled: it was either a temporary drop, an admin error, or it’s being updated. If it returns, it’ll reappear on the store automatically.";
  }
  if (m.includes("refund") || m.includes("return")) {
    return "Refunds are only considered for confirmed defects or damage. Include clear photos and your order email so staff can review.";
  }
  return "Ticket received. Staff will reply here when available.";
}

r.get("/", (req, res) => {
  res.render("support", { error: "", created: null });
});

r.post("/", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().slice(0, 180);
    const subject = String(req.body.subject || "").trim().slice(0, 140);
    const message = String(req.body.message || "").trim().slice(0, 2000);
    if (!message) return res.render("support", { error: "Message required.", created: null });

    const publicId = makeId();
    const systemReply = autoReply(message);

    const t = await Ticket.create({
      publicId,
      email,
      subject,
      status: "open",
      messages: [
        { by: "user", text: message, ts: new Date() },
        { by: "system", text: systemReply, ts: new Date() },
      ],
      updatedAt: new Date(),
    });

    // cookie binds this browser to this ticket
    const ticketToken = signJwt({ ticket: publicId, ts: Date.now() });
    res.cookie("ticket_token", ticketToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    });

    return res.redirect(`/support/${publicId}`);
  } catch (e) {
    console.error(e);
    return res.render("support", { error: "Failed to create ticket.", created: null });
  }
});

r.get("/:publicId", async (req, res) => {
  const publicId = String(req.params.publicId || "").trim();
  const ticket = await Ticket.findOne({ publicId }).lean();
  if (!ticket) return res.status(404).send("Not found");

  // NOTE: token check happens on socket join; page can render safely without leaking anything sensitive
  res.render("support_thread", { ticket });
});

export default r;
