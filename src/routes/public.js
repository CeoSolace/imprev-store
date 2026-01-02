import { Router } from "express";
import crypto from "crypto";

import { Product } from "../models/Product.js";
import { Code } from "../models/Code.js";
import { Settings } from "../models/Settings.js";
import { Ticket } from "../models/Ticket.js";

import { stripe } from "../config/stripe.js";
import {
  priceToHitProfit,
  stripeFeeForAmount,
  regionFromCountry,
  ALLOWED_SHIP_COUNTRIES,
} from "../config/money.js";

const r = Router();

function getBaseUrl(req) {
  const envUrl = (process.env.BASE_URL || "").trim();
  if (envUrl) return envUrl.replace(/\/+$/, "");

  const proto =
    String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
    (req.secure ? "https" : "http");

  const host = req.headers.host;
  return `${proto}://${host}`;
}

function makePublicId() {
  return crypto.randomBytes(5).toString("hex").slice(0, 8).toUpperCase();
}

function detectAutoReply(message = "", subject = "") {
  const m = `${subject}\n${message}`.toLowerCase();

  if (m.includes("discord") || m.includes("ban") || m.includes("mute") || m.includes("kick") || m.includes("role")) {
    return "For Discord-related issues, ask the Discord staff. Website support can’t handle Discord moderation or server problems.";
  }

  if (
    m.includes("disabled") ||
    m.includes("not found") ||
    m.includes("removed") ||
    m.includes("disappeared") ||
    m.includes("gone")
  ) {
    return "Some products are temporary drops or may be disabled due to an error while updating inventory/variants. If it’s a drop item, it may return later.";
  }

  if (m.includes("checkout") || m.includes("stripe") || m.includes("payment") || m.includes("card")) {
    return "If checkout fails: refresh once, then try again. If it still fails, include your country code and what product/variant you selected so staff can check configuration.";
  }

  return "Ticket received. Staff will respond here when available.";
}

// -------------------------
// Store
// -------------------------
r.get("/", async (req, res) => {
  const products = await Product.find({ active: true }).sort({ createdAt: -1 }).lean();
  res.render("store", { products });
});

r.get("/p/:id", async (req, res) => {
  const product = await Product.findById(req.params.id).lean();
  if (!product || !product.active) return res.status(404).send("Not found");
  res.render("product", { product });
});

r.get("/success", (req, res) => res.render("success"));
r.get("/cancel", (req, res) => res.render("cancel"));

// -------------------------
// Stripe checkout
// -------------------------
r.post("/checkout", async (req, res) => {
  try {
    const { productId, variantSku, size, qty, country, referenceCode, referralCode, email } = req.body;

    const quantity = Math.max(1, Math.min(10, Number(qty || 1)));
    const region = regionFromCountry(country || "GB");

    const product = await Product.findById(productId).lean();
    if (!product || !product.active) return res.status(400).send("Bad product");

    const variant = (product.variants || []).find((v) => v.sku === variantSku);
    if (!variant) return res.status(400).send("Bad variant");

    const normSize = String(size || "").trim();
    if (!normSize) return res.status(400).send("Bad size");
    if (Array.isArray(variant.sizes) && variant.sizes.length && !variant.sizes.includes(normSize)) {
      return res.status(400).send("Bad size");
    }

    if (!variant.printfulVariantId) return res.status(400).send("Variant not configured");

    if (referenceCode) {
      const ok = await Code.findOne({
        type: "reference",
        code: String(referenceCode).toUpperCase().trim(),
        active: true,
      }).lean();
      if (!ok) return res.status(400).send("Invalid reference code");
    }

    let profit = Number(variant.profit?.[region] ?? 0);
    if (!Number.isFinite(profit) || profit < 0) profit = 0;

    if (referralCode) {
      const c = await Code.findOne({
        type: "referral",
        code: String(referralCode).toUpperCase().trim(),
        active: true,
      }).lean();

      if (!c) return res.status(400).send("Invalid referral code");
      if (c.maxUses > 0 && c.used >= c.maxUses) return res.status(400).send("Referral code exhausted");

      const pct = Math.max(0, Math.min(90, Number(c.discountPercent || 0)));
      profit = Math.max(0, Math.floor(profit * (1 - pct / 100)));
    }

    const settings = await Settings.findOne().lean();
    const feeModel = settings?.stripeFees?.[region] || settings?.stripeFees?.ROW;
    if (!feeModel) return res.status(500).send("Stripe fee model missing");

    const currency = String(feeModel.currency || "GBP");

    const manufacturing = Number(variant.costs?.manufacturing ?? 0);
    const ship = Number(variant.costs?.shipping?.[region] ?? 0);

    if (!Number.isFinite(manufacturing) || !Number.isFinite(ship)) {
      return res.status(500).send("Costs misconfigured");
    }

    const baseCost = manufacturing + ship;

    // IMPORTANT: priceToHitProfit must return minor units integer.
    let unitAmount = priceToHitProfit(
      baseCost,
      profit,
      { percent: feeModel.percent, fixed: feeModel.fixed },
      10
    );

    unitAmount = Math.round(Number(unitAmount || 0));

    // Prevent the famous “£0.90” disaster
    if (!Number.isFinite(unitAmount) || unitAmount < 50) {
      return res.status(500).send("Pricing error (unit amount too low)");
    }

    const fee = stripeFeeForAmount(unitAmount, { percent: feeModel.percent, fixed: feeModel.fixed });
    const realized = unitAmount - fee - baseCost;
    if (realized < profit) return res.status(400).send("Pricing safety check failed");

    const baseUrl = getBaseUrl(req);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email || undefined,
      success_url: `${baseUrl}/success`,
      cancel_url: `${baseUrl}/cancel`,
      shipping_address_collection: { allowed_countries: ALLOWED_SHIP_COUNTRIES },
      line_items: [
        {
          quantity,
          price_data: {
            currency: currency.toLowerCase(),
            unit_amount: unitAmount,
            product_data: {
              name: `Imprev Clothing - ${product.name}`,
              description: `${variant.name} | ${normSize}`,
              images: product.images?.slice(0, 1),
            },
          },
        },
      ],
      metadata: {
        productId,
        variantSku,
        size: normSize,
        qty: String(quantity),
        country: String(country || "GB").toUpperCase(),
        region,
        referenceCode: String(referenceCode || "").toUpperCase().trim(),
        referralCode: String(referralCode || "").toUpperCase().trim(),
        baseCost: String(baseCost),
        profit: String(profit),
        unitAmount: String(unitAmount),
        printfulVariantId: String(variant.printfulVariantId),
      },
    });

    if (!session?.url) {
      console.error("Stripe session missing URL:", session);
      return res.status(500).send("Stripe session error");
    }

    return res.redirect(303, session.url);
  } catch (e) {
    console.error("CHECKOUT ERROR:", e);
    return res.status(500).send("Checkout failed");
  }
});

// -------------------------
// Support
// -------------------------
r.get("/support", (req, res) => {
  res.render("support", { error: "", created: null });
});

r.post("/support", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().slice(0, 140);
    const subject = String(req.body.subject || "").trim().slice(0, 160);
    const message = String(req.body.message || "").trim().slice(0, 4000);

    if (!message) return res.render("support", { error: "Message required.", created: null });

    let publicId = makePublicId();
    for (let i = 0; i < 3; i++) {
      const exists = await Ticket.findOne({ publicId }).lean();
      if (!exists) break;
      publicId = makePublicId();
    }

    const systemReply = detectAutoReply(message, subject);
    const activeCount = await Product.countDocuments({ active: true });

    const ticket = await Ticket.create({
      publicId,
      email: email || "",
      subject: subject || "Support Ticket",
      status: "open",
      systemReply,
      context: { activeCount },
      messages: [
        { from: "user", text: message },
        { from: "system", text: systemReply },
      ],
    });

    const threadUrl = `/support/${ticket.publicId}`;

    res.render("support", {
      error: "",
      created: {
        publicId: ticket.publicId,
        systemReply,
        threadUrl,
      },
    });
  } catch (e) {
    console.error("SUPPORT CREATE ERROR:", e);
    res.render("support", { error: "Failed to create ticket.", created: null });
  }
});

r.get("/support/:publicId", async (req, res) => {
  const publicId = String(req.params.publicId || "").trim().toUpperCase();
  const ticket = await Ticket.findOne({ publicId }).lean();
  if (!ticket) return res.status(404).send("Ticket not found.");
  res.render("support_thread", { ticket, error: "" });
});

r.post("/support/:publicId/message", async (req, res) => {
  const publicId = String(req.params.publicId || "").trim().toUpperCase();
  const text = String(req.body.message || "").trim().slice(0, 4000);

  const ticket = await Ticket.findOne({ publicId });
  if (!ticket) return res.status(404).send("Ticket not found.");

  if (!text) return res.redirect(`/support/${encodeURIComponent(publicId)}`);

  // Reopen if closed
  if (ticket.status === "closed") ticket.status = "open";

  ticket.messages.push({ from: "user", text });
  await ticket.save();

  res.redirect(`/support/${encodeURIComponent(publicId)}`);
});

export default r;
