import mongoose from "mongoose";
import crypto from "crypto";

function makePublicId() {
  return `T-${Math.random().toString(36).slice(2, 7).toUpperCase()}${Date.now()
    .toString(36)
    .slice(-3)
    .toUpperCase()}`;
}

const TicketMessageSchema = new mongoose.Schema(
  {
    from: { type: String, enum: ["user", "system", "admin"], required: true },
    text: { type: String, required: true },
    ts: { type: Date, default: Date.now },
  },
  { _id: false }
);

const TicketSchema = new mongoose.Schema(
  {
    publicId: { type: String, unique: true, index: true, default: makePublicId },

    // ✅ hashed ticket access key (never store the raw key)
    accessKeyHash: { type: String, default: "", index: true },

    status: { type: String, enum: ["open", "closed"], default: "open", index: true },
    category: { type: String, default: "other", index: true },

    email: { type: String, default: "" },
    subject: { type: String, default: "" },

    pageUrl: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    ip: { type: String, default: "" },

    messages: { type: [TicketMessageSchema], default: [] },

    lastAdminAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// tiny helper (optional)
TicketSchema.statics.hashKey = function hashKey(key) {
  return crypto.createHash("sha256").update(String(key || "")).digest("hex");
};

export const Ticket = mongoose.model("Ticket", TicketSchema);
