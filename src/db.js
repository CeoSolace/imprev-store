import mongoose from "mongoose";
import { ensureAdmin } from "./models/Admin.js";
import { ensureSettings } from "./models/Settings.js";

export async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI missing");
  await mongoose.connect(uri);

  await ensureAdmin();
  await ensureSettings();

  console.log("MongoDB connected");
}
