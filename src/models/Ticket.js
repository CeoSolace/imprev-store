import mongoose from "mongoose";

const MsgSchema = new mongoose.Schema(
  {
    from: { type: String, enum: ["user", "system", "admin"], required: true },
    text: { type: String, required: true },
  },
  { timestamps: true }
);

const TicketSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ["open", "closed"], default: "open", index: true },
    email: { type: String, default: "" },
    subject: { type: String, default: "" },
    category: {
      type: String,
      enum: ["order", "product", "refund", "discord", "other"],
      default: "other",
      index: true,
    },
    pageUrl: { type: String, default: "" }, // where they submitted from
    userAgent: { type: String, default: "" },
    ip: { type: String, default: "" },

    // Simple “ticket id” humans can reference
    publicId: { type: String, unique: true, index: true },

    messages: { type: [MsgSchema], default: [] },
  },
  { timestamps: true }
);

TicketSchema.pre("validate", function (next) {
  if (!this.publicId) {
    // short-ish id, not guessable enough to matter (admin auth still required)
    this.publicId = `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
  }
  next();
});

export const Ticket = mongoose.model("Ticket", TicketSchema);
