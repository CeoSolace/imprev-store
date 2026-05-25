import mongoose from "mongoose";
import { ensureAdmin } from "./models/Admin.js";
import { ensureSettings } from "./models/Settings.js";
import { initLocalStore } from "./localStore.js";

let legacyConnection = null;

export async function connectDb() {
  const legacyUri = process.env.MONGODB_URI;

  if (!legacyUri) {
    throw new Error("MONGODB_URI missing");
  }

  legacyConnection = await mongoose.createConnection(legacyUri).asPromise();

  await ensureAdmin();
  await ensureSettings();

  await initLocalStore();

  console.log("Legacy MongoDB connected");
  console.log("VPS local storage initialized");
}

export function getLegacyDb() {
  return legacyConnection;
}
