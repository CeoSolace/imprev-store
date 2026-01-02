import mongoose from "mongoose";

function makePublicId() {
  // short, readable id for users
  return `T-${Math.random().toString(36).slice(2, 7).toUpperCase()}${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

const TicketMessageSchema = new mongoose.Schema(
  {
    from: { type: String, enum: ["user", "system", "admin"], required: true },
    text: { type: String, required: true },
  },
  { _id: false, timestamps: true }
);

const TicketSchema = new mongoose.Schema(
  {
    publicId: { type: String, unique: true, index: true, default: makePublicId },

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

export const Ticket = mongoose.model("Ticket", TicketSchema);
