import mongoose from "mongoose";

const AnnouncementSchema = new mongoose.Schema({
  storeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Store",
    required: true,
    index: true
  },
  content: {
    type: String,
    required: true,
    maxlength: 500
  },
  type: {
    type: String,
    enum: ["update", "drop", "restock", "announcement"],
    default: "announcement"
  }
}, { timestamps: true });

export const Announcement = mongoose.models.Announcement || mongoose.model("Announcement", AnnouncementSchema);
