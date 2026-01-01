import { Router } from "express";
import bcrypt from "bcryptjs";
import multer from "multer";

import { Admin } from "../models/Admin.js";
import { Product } from "../models/Product.js";
import { Order } from "../models/Order.js";
import { Code } from "../models/Code.js";
import { Settings } from "../models/Settings.js";

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
  res.render("admin/dashboard", { products, orders, failed });
});

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

// ✅ passes settings/fees to template (so pricing UI can show fee info)
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
 * This accepts either single values or arrays from the form.
 * Regions: UK + US only (GBP + USD) as requested.
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
  const shipUSArr = toArr(req.body.shipUS);
  const profitUKArr = toArr(req.body.profitUK);
  const profitUSArr = toArr(req.body.profitUS);

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
    const shipUS = Number(shipUSArr[i] ?? 0);

    const profitUK = Number(profitUKArr[i] ?? 0);
    const profitUS = Number(profitUSArr[i] ?? 0);

    // skip blank row
    const emptyRow = !sku && !name && !printfulVariantId;
    if (emptyRow) continue;

    if (!sku) { errors.push(`Row ${i + 1}: SKU required`); continue; }
    if (seenSkus.has(sku)) { errors.push(`Row ${i + 1}: Duplicate SKU "${sku}" in this submit`); continue; }
    seenSkus.add(sku);

    if (!name) { errors.push(`Row ${i + 1}: Variant name required`); continue; }
    if (!sizes.length) { errors.push(`Row ${i + 1}: Sizes required (comma separated)`); continue; }
    if (!printfulVariantId) { errors.push(`Row ${i + 1}: Printful Variant ID required`); continue; }

    if (manufacturing < 0) { errors.push(`Row ${i + 1}: Manufacturing must be >= 0`); continue; }
    if (shipUK < 0 || shipUS < 0) { errors.push(`Row ${i + 1}: Shipping must be >= 0`); continue; }
    if (profitUK < 0 || profitUS < 0) { errors.push(`Row ${i + 1}: Profit cannot be negative`); continue; }

    const variant = {
      sku,
      name,
      sizes,
      printfulVariantId,
      costs: {
        manufacturing,
        shipping: { UK: shipUK, US: shipUS },
      },
      profit: { UK: profitUK, US: profitUS },
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

r.get("/orders", adminOnly, async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 }).limit(250).lean();
  res.render("admin/orders", { orders });
});

r.get("/settings", adminOnly, async (req, res) => {
  const settings = await Settings.findOne().lean();
  res.render("admin/settings", { settings });
});

// ✅ won’t crash if settings doc doesn't exist
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

export default r;
