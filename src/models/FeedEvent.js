import mongoose from "mongoose";

const FeedEventSchema = new mongoose.Schema({
  storeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Store",
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: [
      "product_drop",
      "announcement",
      "restock",
      "milestone",
      "member_join",
      "verification"
    ],
    required: true
  },
  title: {
    type: String,
    required: true
  },
  content: {
    type: String,
    default: ""
  },
  metadata: {
    type: Object,
    default: {}
  }
}, { timestamps: true });

FeedEventSchema.index({ createdAt: -1 });

export const FeedEvent = mongoose.models.FeedEvent || mongoose.model("FeedEvent", FeedEventSchema);
