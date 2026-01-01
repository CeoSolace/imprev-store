import mongoose from "mongoose";

const CodeSchema = new mongoose.Schema({
  type: { type: String, enum: ["reference", "referral"], required: true },
  code: { type: String, unique: true, required: true },
  active: { type: Boolean, default: true },

  // referral only
  discountPercent: { type: Number, default: 0 },
  maxUses: { type: Number, default: 0 },
  used: { type: Number, default: 0 },

  note: { type: String, default: "" }
}, { timestamps: true });

export const Code = mongoose.model("Code", CodeSchema);
