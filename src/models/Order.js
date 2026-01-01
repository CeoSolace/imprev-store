import mongoose from "mongoose";

const OrderSchema = new mongoose.Schema({
  stripeSessionId: { type: String, unique: true, required: true },
  status: { type: String, enum: ["paid", "fulfilled", "failed"], default: "paid" },

  email: String,
  currency: String,
  amountTotal: Number,

  shipping: Object,

  referenceCode: String,
  referralCode: String,

  items: { type: Array, default: [] }, // [{productId, variantSku, size, qty, region, baseCost, profit, unitAmount, printfulVariantId}]

  printfulOrderId: String,
  tracking: Object
}, { timestamps: true });

export const Order = mongoose.model("Order", OrderSchema);
