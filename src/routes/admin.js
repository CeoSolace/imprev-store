import { Router } from "express";
import bcrypt from "bcryptjs";
import multer from "multer";

import { Admin } from "../models/Admin.js";
import { Product } from "../models/Product.js";
import { Order } from "../models/Order.js";
import { Code } from "../models/Code.js";
import { Settings } from "../models/Settings.js";
import { Ticket } from "../models/Ticket.js";

import { signJwt } from "../middleware/jwt.js";
import { adminOnly } from "../middleware/adminOnly.js";
import { uploadImageBuffer } from "../config/cloudinary.js";

const r = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
});

r.get("/login", (req, res) => res.render("admin/login", { err: "" }));

r.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const admin = await Admin.findOne({ email }).lean();
  if (!admin) return res.render("admin/login", { err: "Bad login" });

  const ok = await bcrypt.compare(password, admin.passHash);
  if (!ok) return res.render("admin/login", { err: "Bad login" });

  const token = signJwt({ email, ts: Date.now() });

  res.cookie("admin_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  res.redirect("/admin");
});

r.post("/logout", adminOnly, (req, res) => {
  res.clearCookie("admin_token");
  res.redirect("/admin/login");
});

r.get("/", adminOnly, async (req, res) => {
  const products = await Product.countDocuments();
  const orders = await Order.countDocuments();
  const failed = await Order.countDocuments({ status: "failed" });

  const ticketsOpen = await Ticket.countDocuments({ status: { $ne: "closed" } });

  res.render("admin/dashboard", { products, orders, failed, ticketsOpen });
});

// -------------------------
// Products
// -------------------------
r.get("/products", adminOnly, async (req, res) => {
  const products = await Product.find().sort({ createdAt: -1 }).lean();
  res.render("admin/products", { products });
});

r.get("/products/new", adminOnly, (req, res) => {
  res.render("admin/product_new");
});

r.post("/products/new", adminOnly, upload.array("images", 6), async (req, res) => {
  const { name, description } = req.body;

  const images = [];
  for (const f of req.files || []) {
    const url = await uploadImageBuffer(f.buffer, f.originalname);
    images.push(url);
  }

  await Product.create({ name, description, images, active: false, variants: [] });
  res.redirect("/admin/products");
});

r.get("/products/:id", adminOnly, async (req, res) => {
  const product = await Product.findById(req.params.id).lean();
  if (!product) return res.redirect("/admin/products");

  const settings = await Settings.findOne().lean();
  const fee = settings?.stripeFees || {};

  res.render("admin/product_edit", { product, fee });
});

r.post("/products/:id/toggle", adminOnly, async (req, res) => {
  const p = await Product.findById(req.params.id);
  if (!p) return res.redirect("/admin/products");
  p.active = !p.active;
  await p.save();
  res.redirect(`/admin/products/${p._id}`);
});

r.post("/products/:id/delete", adminOnly, async (req, res) => {
  await Product.deleteOne({ _id: req.params.id });
  res.redirect("/admin/products");
});

r.post("/products/:id/add-image", adminOnly, upload.single("image"), async (req, res) => {
  const p = await Product.findById(req.params.id);
  if (!p) return res.redirect("/admin/products");
  if (!req.file) return res.redirect(`/admin/products/${p._id}`);

  const url = await uploadImageBuffer(req.file.buffer, req.file.originalname);
  p.images.push(url);
  await p.save();
  res.redirect(`/admin/products/${p._id}`);
});

r.post("/products/:id/remove-image", adminOnly, async (req, res) => {
  const { url } = req.body;
  const p = await Product.findById(req.params.id);
  if (!p) return res.redirect("/admin/products");
  p.images = (p.images || []).filter((u) => u !== url);
  await p.save();
  res.redirect(`/admin/products/${p._id}`);
});

/**
 * ✅ MULTI-VARIANT UPSERT (ONE SUBMIT)
 */
r.post("/products/:id/variant", adminOnly, async (req, res) => {
  const p = await Product.findById(req.params.id);
  if (!p) return res.redirect("/admin/products");

  const toArr = (v) => (Array.isArray(v) ? v : [v]);

  const skuArr = toArr(req.body.sku);
  const vnameArr = toArr(req.body.vname);
  const sizesArr = toArr(req.body.sizes);
  const printfulVariantIdArr = toArr(req.body.printfulVariantId);

  const manufacturingArr = toArr(req.body.manufacturing);

  const shipUKArr = toArr(req.body.shipUK);
  const shipEUArr = toArr(req.body.shipEU);
  const shipUSArr = toArr(req.body.shipUS);
  const shipTRArr = toArr(req.body.shipTR);
  const shipROWArr = toArr(req.body.shipROW);

  const profitUKArr = toArr(req.body.profitUK);
  const profitEUArr = toArr(req.body.profitEU);
  const profitUSArr = toArr(req.body.profitUS);
  const profitTRArr = toArr(req.body.profitTR);
  const profitROWArr = toArr(req.body.profitROW);

  const n = Math.max(
    skuArr.length,
    vnameArr.length,
    sizesArr.length,
    printfulVariantIdArr.length,
    manufacturingArr.length
  );

  const errors = [];
  const seenSkus = new Set();

  for (let i = 0; i < n; i++) {
    const sku = String(skuArr[i] ?? "").trim();
    const name = String(vnameArr[i] ?? "").trim();
    const sizes = String(sizesArr[i] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const printfulVariantId = Number(printfulVariantIdArr[i] ?? 0);
    const manufacturing = Number(manufacturingArr[i] ?? 0);

    const shipUK = Number(shipUKArr[i] ?? 0);
    const shipEU = Number(shipEUArr[i] ?? 0);
    const shipUS = Number(shipUSArr[i] ?? 0);
    const shipTR = Number(shipTRArr[i] ?? 0);
    const shipROW = Number(shipROWArr[i] ?? 0);

    const profitUK = Number(profitUKArr[i] ?? 0);
    const profitEU = Number(profitEUArr[i] ?? 0);
    const profitUS = Number(profitUSArr[i] ?? 0);
    const profitTR = Number(profitTRArr[i] ?? 0);
    const profitROW = Number(profitROWArr[i] ?? 0);

    const emptyRow = !sku && !name && !printfulVariantId;
    if (emptyRow) continue;

    if (!sku) { errors.push(`Row ${i + 1}: SKU required`); continue; }
    if (seenSkus.has(sku)) { errors.push(`Row ${i + 1}: Duplicate SKU "${sku}"`); continue; }
    seenSkus.add(sku);

    if (!name) { errors.push(`Row ${i + 1}: Variant name required`); continue; }
    if (!sizes.length) { errors.push(`Row ${i + 1}: Sizes required`); continue; }
    if (!printfulVariantId) { errors.push(`Row ${i + 1}: Printful Variant ID required`); continue; }

    if (manufacturing < 0) { errors.push(`Row ${i + 1}: Manufacturing must be >= 0`); continue; }
    if (shipUK < 0 || shipEU < 0 || shipUS < 0 || shipTR < 0 || shipROW < 0) {
      errors.push(`Row ${i + 1}: Shipping must be >= 0`); continue;
    }
    if (profitUK < 0 || profitEU < 0 || profitUS < 0 || profitTR < 0 || profitROW < 0) {
      errors.push(`Row ${i + 1}: Profit cannot be negative`); continue;
    }

    const variant = {
      sku,
      name,
      sizes,
      printfulVariantId,
      costs: {
        manufacturing,
        shipping: { UK: shipUK, EU: shipEU, US: shipUS, TR: shipTR, ROW: shipROW },
      },
      profit: { UK: profitUK, EU: profitEU, US: profitUS, TR: profitTR, ROW: profitROW },
    };

    const idx = (p.variants || []).findIndex((v) => v.sku === sku);
    if (idx >= 0) p.variants[idx] = variant;
    else p.variants.push(variant);
  }

  if (errors.length) return res.status(400).send(errors.join("\n"));

  await p.save();
  res.redirect(`/admin/products/${p._id}`);
});

r.post("/products/:id/variant-delete", adminOnly, async (req, res) => {
  const { sku } = req.body;
  const p = await Product.findById(req.params.id);
  if (!p) return res.redirect("/admin/products");
  p.variants = (p.variants || []).filter((v) => v.sku !== sku);
  await p.save();
  res.redirect(`/admin/products/${p._id}`);
});

// -------------------------
// Codes
// -------------------------
r.get("/codes", adminOnly, async (req, res) => {
  const codes = await Code.find().sort({ createdAt: -1 }).lean();
  res.render("admin/codes", { codes });
});

r.post("/codes/new", adminOnly, async (req, res) => {
  const { type, code, discountPercent, maxUses, note } = req.body;

  await Code.create({
    type,
    code: String(code || "").toUpperCase().trim(),
    discountPercent: Number(discountPercent || 0),
    maxUses: Number(maxUses || 0),
    note: String(note || ""),
  });

  res.redirect("/admin/codes");
});

r.post("/codes/:id/toggle", adminOnly, async (req, res) => {
  const c = await Code.findById(req.params.id);
  if (c) {
    c.active = !c.active;
    await c.save();
  }
  res.redirect("/admin/codes");
});

r.post("/codes/:id/delete", adminOnly, async (req, res) => {
  await Code.deleteOne({ _id: req.params.id });
  res.redirect("/admin/codes");
});

// -------------------------
// Orders
// -------------------------
r.get("/orders", adminOnly, async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 }).limit(250).lean();
  res.render("admin/orders", { orders });
});

// -------------------------
// Settings
// -------------------------
r.get("/settings", adminOnly, async (req, res) => {
  const settings = await Settings.findOne().lean();
  res.render("admin/settings", { settings });
});

r.post("/settings", adminOnly, async (req, res) => {
  let s = await Settings.findOne();
  if (!s) s = await Settings.create({ stripeFees: {} });

  const toFee = (prefix) => ({
    currency: String(req.body[`${prefix}Cur`] || "").toUpperCase().trim(),
    percent: Number(req.body[`${prefix}Pct`] || 0),
    fixed: Number(req.body[`${prefix}Fix`] || 0),
  });

  s.stripeFees = {
    UK: toFee("uk"),
    EU: toFee("eu"),
    US: toFee("us"),
    TR: toFee("tr"),
    ROW: toFee("row"),
  };

  for (const k of ["UK", "EU", "US", "TR", "ROW"]) {
    const f = s.stripeFees[k];
    if (!f.currency) return res.status(400).send("Currency required for all regions");
    if (f.percent < 0 || f.percent >= 1) return res.status(400).send("Percent must be 0..1");
    if (f.fixed < 0) return res.status(400).send("Fixed must be >=0");
  }

  await s.save();
  res.redirect("/admin/settings");
});

// -------------------------
// Tickets (Admin)
// -------------------------
r.get("/tickets", adminOnly, async (req, res) => {
  const status = String(req.query.status || "open").trim().toLowerCase();
  const q = String(req.query.q || "").trim();

  const filter = {};
  if (status === "closed") filter.status = "closed";
  else filter.status = { $ne: "closed" };

  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { publicId: q.toUpperCase() },
      { email: new RegExp(safe, "i") },
      { subject: new RegExp(safe, "i") },
    ];
  }

  const tickets = await Ticket.find(filter).sort({ updatedAt: -1 }).limit(300).lean();
  res.render("admin/tickets", { tickets, status, q });
});

r.get("/tickets/:publicId", adminOnly, async (req, res) => {
  const publicId = String(req.params.publicId || "").trim().toUpperCase();
  const ticket = await Ticket.findOne({ publicId }).lean();
  if (!ticket) return res.redirect("/admin/tickets");
  res.render("admin/ticket_view", { ticket, err: "" });
});

r.post("/tickets/:publicId/reply", adminOnly, async (req, res) => {
  const publicId = String(req.params.publicId || "").trim().toUpperCase();
  const text = String(req.body.message || "").trim().slice(0, 4000);
  if (!text) return res.redirect(`/admin/tickets/${encodeURIComponent(publicId)}`);

  const ticket = await Ticket.findOne({ publicId });
  if (!ticket) return res.redirect("/admin/tickets");

  if (ticket.status === "closed") {
    return res.render("admin/ticket_view", { ticket: ticket.toObject(), err: "Ticket is closed." });
  }

  ticket.messages.push({ from: "admin", text });
  await ticket.save();

  res.redirect(`/admin/tickets/${encodeURIComponent(publicId)}`);
});

r.post("/tickets/:publicId/close", adminOnly, async (req, res) => {
  const publicId = String(req.params.publicId || "").trim().toUpperCase();
  const ticket = await Ticket.findOne({ publicId });
  if (!ticket) return res.redirect("/admin/tickets");

  ticket.status = "closed";
  await ticket.save();

  res.redirect(`/admin/tickets/${encodeURIComponent(publicId)}`);
});

r.post("/tickets/:publicId/delete", adminOnly, async (req, res) => {
  const publicId = String(req.params.publicId || "").trim().toUpperCase();
  await Ticket.deleteOne({ publicId });
  res.redirect("/admin/tickets");
});

export default r;
