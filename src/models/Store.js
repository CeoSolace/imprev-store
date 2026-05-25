import mongoose from "mongoose";

const StoreSchema = new mongoose.Schema({
  ownerEmail: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true
  },
  bio: {
    type: String,
    default: ""
  },
  logo: {
    type: String,
    default: ""
  },
  banner: {
    type: String,
    default: ""
  },
  accentColor: {
    type: String,
    default: "#5865F2"
  },
  socials: {
    discord: { type: String, default: "" },
    twitter: { type: String, default: "" },
    website: { type: String, default: "" }
  },
  verified: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

export const Store = mongoose.models.Store || mongoose.model("Store", StoreSchema);
