import mongoose from "mongoose";

const NotificationSchema = new mongoose.Schema({
  recipientKey: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  type: {
    type: String,
    default: "general"
  },
  title: {
    type: String,
    required: true
  },
  body: {
    type: String,
    default: ""
  },
  read: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

NotificationSchema.index({ recipientKey: 1, createdAt: -1 });

export const Notification = mongoose.models.Notification || mongoose.model("Notification", NotificationSchema);
