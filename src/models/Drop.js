import mongoose from "mongoose";

const DropSchema = new mongoose.Schema({
  storeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Store",
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ""
  },
  startsAt: {
    type: Date,
    required: true,
    index: true
  },
  endsAt: {
    type: Date,
    required: true
  },
  limited: {
    type: Boolean,
    default: false
  },
  maxPurchases: {
    type: Number,
    default: 0
  },
  active: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

DropSchema.index({ active: 1, startsAt: 1 });

export const Drop = mongoose.models.Drop || mongoose.model("Drop", DropSchema);
