import mongoose from "mongoose";
import { ensureAdmin } from "./models/Admin.js";
import { ensureSettings } from "./models/Settings.js";

let legacyConnection = null;
let primaryConnection = null;

export async function connectDb() {
  const legacyUri = process.env.MONGODB_URI;
  const primaryUri = process.env.PRIMARY_MONGODB_URI || legacyUri;

  if (!legacyUri) {
    throw new Error("MONGODB_URI missing");
  }

  legacyConnection = await mongoose.createConnection(legacyUri).asPromise();

  primaryConnection = await mongoose.createConnection(primaryUri).asPromise();

  await ensureAdmin();
  await ensureSettings();

  console.log("Legacy MongoDB connected");
  console.log("Primary VPS MongoDB connected");
}

export function getLegacyDb() {
  return legacyConnection;
}

export function getPrimaryDb() {
  return primaryConnection;
}
