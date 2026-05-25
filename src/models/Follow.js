import mongoose from "mongoose";

const FollowSchema = new mongoose.Schema({
  followerKey: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true
  },
  storeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Store",
    required: true,
    index: true
  }
}, { timestamps: true });

FollowSchema.index({ followerKey: 1, storeId: 1 }, { unique: true });

export const Follow = mongoose.models.Follow || mongoose.model("Follow", FollowSchema);
