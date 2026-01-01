import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const AdminSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  passHash: { type: String, required: true }
}, { timestamps: true });

export const Admin = mongoose.model("Admin", AdminSchema);

export async function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error("ADMIN_EMAIL / ADMIN_PASSWORD missing");

  let admin = await Admin.findOne({ email });
  if (!admin) {
    const passHash = await bcrypt.hash(password, 12);
    admin = await Admin.create({ email, passHash });
    console.log("Admin created (from env)");
  }
}
