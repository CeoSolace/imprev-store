import { Router } from "express";
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

/* -------------------------
   Base URL helper (Render/CF)
-------------------------- */
function getBaseUrl(req) {
  const envUrl = String(process.env.BASE_URL || "").trim();
  if (envUrl) return envUrl.replace(/\/+$/, "");

  const proto =
    String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
    (req.secure ? "https" : "http");

  const host = String(req.headers.host || "").trim();
  return `${proto}://${host}`;
}

/* -------------------------
   Support auto-reply helpers
-------------------------- */
function normalizeText(s) {
  return String(s || "").toLowerCase();
}

function pickCategory(subject, message) {
  const t = normalizeText(`${subject} ${message}`);

  if (t.includes("discord") || t.includes("server") || t.includes("invite")) return "discord";
  if (t.includes("refund") || t.includes("return") || t.includes("chargeback")) return "refund";
  if (t.includes("order") || t.includes("shipping") || t.includes("delivery") || t.includes("tracking")) return "order";
  if (t.includes("product") || t.includes("disabled") || t.includes("not found") || t.includes("variant") || t.includes("size")) return "product";
  return "other";
}

function autoReplyFor(category, subject, message) {
  const t = normalizeText(`${subject} ${message}`);

  // Discord-related
  if (category === "discord") {
    return "If your question is about Discord, please ask the Discord staff directly. We can’t help with Discord moderation or server issues through the website.";
  }

  // Product disabled / not found
  if (category === "product" && (t.includes("disabled") || t.includes("not found") || t.includes("gone"))) {
    return "If a product is disabled, it’s usually because it was a temporary drop, it was listed by mistake, or it’s being corrected (pricing/images/variants). If you tell us which product, we can confirm the exact reason.";
  }

  // Refunds
  if (category === "refund") {
    return "Refunds are only considered for confirmed damage or manufacturing defects. If your item arrived damaged, reply with your receipt email and clear photos of the damage so we can review it.";
  }

  // Orders/shipping
  if (category === "order") {
    return "For order help: include your receipt email, destination country, and any tracking info you received. If it’s a fulfillment delay, we’ll confirm the latest status.";
  }

  return "Thanks. Your ticket has been received. A staff member will respond when available.";
}

/* -------------------------
   Store routes
-------------------------- */
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

/* -------------------------
   Support routes (tickets)
-------------------------- */
r.get("/support", (req, res) => {
  res.render("support", { created: null, error: null });
});

r.post("/support", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().slice(0, 120);
    const subject = String(req.body.subject || "").trim().slice(0, 120);
    const message = String(req.body.message || "").trim().slice(0, 4000);

    if (!message) {
      return res.status(400).render("support", { created: null, error: "Message is required." });
    }

    const category = pickCategory(subject, message);
    const systemReply = autoReplyFor(category, subject, message);

    const t = await Ticket.create({
      email,
      subject,
      category,
      pageUrl: String(req.headers.referer || "").slice(0, 300),
      userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
      ip: req.ip,
      messages: [
        { from: "user", text: message },
        { from: "system", text: systemReply },
      ],
    });

    return res.status(200).render("support", {
      created: { publicId: t.publicId, systemReply },
      error: null,
    });
  } catch (e) {
    console.error("SUPPORT CREATE ERROR:", e);
    return res.status(500).render("support", { created: null, error: "Support system error." });
  }
});

/* -------------------------
   Stripe checkout
-------------------------- */
r.post("/checkout", async (req, res) => {
  try {
    const {
      productId,
      variantSku,
      size,
      qty,
      country,
      referenceCode,
      referralCode,
      email,
    } = req.body;

    const quantity = Math.max(1, Math.min(10, Number(qty || 1)));
    const region = regionFromCountry(country || "GB");

    const product = await Product.findById(productId).lean();
    if (!product || !product.active) return res.status(400).send("Bad product");

    const variant = (product.variants || []).find((v) => v.sku === variantSku);
    if (!variant) return res.status(400).send("Bad variant");

    // Size validation
    const normSize = String(size || "").trim();
    if (!normSize) return res.status(400).send("Bad size");
    if (Array.isArray(variant.sizes) && variant.sizes.length && !variant.sizes.includes(normSize)) {
      return res.status(400).send("Bad size");
    }

    if (!variant.printfulVariantId) return res.status(400).send("Variant not configured");

    // Optional reference code
    if (referenceCode) {
      const ok = await Code.findOne({
        type: "reference",
        code: String(referenceCode).toUpperCase().trim(),
        active: true,
      }).lean();
      if (!ok) return res.status(400).send("Invalid reference code");
    }

    // Profit
    let profit = Number(variant.profit?.[region] ?? 0);
    if (!Number.isFinite(profit) || profit < 0) profit = 0;

    // Optional referral code (discount hits profit)
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

    // Costs should be in MINOR UNITS (pence/cents) to match Stripe unit_amount
    const manufacturing = Number(variant.costs?.manufacturing ?? 0);
    const ship = Number(variant.costs?.shipping?.[region] ?? 0);

    if (!Number.isFinite(manufacturing) || !Number.isFinite(ship)) {
      return res.status(500).send("Costs misconfigured");
    }

    const baseCost = manufacturing + ship;

    // Compute unit amount (minor units, integer)
    let unitAmount = priceToHitProfit(
      baseCost,
      profit,
      { percent: feeModel.percent, fixed: feeModel.fixed },
      10
    );

    unitAmount = Math.round(Number(unitAmount || 0));

    // Hard floor to prevent stupid outcomes (and signals misconfig)
    // This does NOT “fix” wrong costs, it prevents a public £0.90 clown show.
    if (!Number.isFinite(unitAmount) || unitAmount < 150) {
      console.error("PRICING ERROR", {
        productId,
        variantSku,
        region,
        currency,
        manufacturing,
        ship,
        baseCost,
        profit,
        unitAmount,
        feeModel,
      });
      return res.status(500).send("Pricing error (unit amount too low)");
    }

    // Safety check: verify realized profit >= target profit (with rounding)
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

export default r;
