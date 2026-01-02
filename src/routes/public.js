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

function getBaseUrl(req) {
  const envUrl = (process.env.BASE_URL || "").trim();
  if (envUrl) return envUrl.replace(/\/+$/, "");
  const proto =
    String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
    (req.secure ? "https" : "http");
  const host = req.headers.host;
  return `${proto}://${host}`;
}

function autoReply(message) {
  const m = String(message || "").toLowerCase();

  if (m.includes("discord")) {
    return "Discord issues: ask the staff in the Discord. Website support can’t help with Discord moderation/server problems.";
  }
  if (m.includes("disabled") || m.includes("removed") || m.includes("not available")) {
    return "If a product is disabled it’s usually temporary (limited drop ended) or it was pulled due to a listing/config error. If it returns, it’ll show back in the store.";
  }
  if (m.includes("refund") || m.includes("return")) {
    return "Refunds are only considered for confirmed damage/defects. If it’s damage: reply with photos + your receipt email + delivery country.";
  }
  if (m.includes("price") || m.includes("charged") || m.includes("payment")) {
    return "Payments are handled via Stripe checkout. If you were charged and something failed, reply with the receipt email and what happened.";
  }
  return "Ticket received. Staff will respond here when available.";
}

// Store
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

// Support (new ticket)
r.get("/support", (req, res) => {
  res.render("support", { error: "", created: null });
});

r.post("/support", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().slice(0, 160);
    const subject = String(req.body.subject || "").trim().slice(0, 140);
    const message = String(req.body.message || "").trim().slice(0, 4000);
    if (!message) return res.render("support", { error: "Message required.", created: null });

    const systemReply = autoReply(message);

    const t = await Ticket.create({
      email,
      subject,
      pageUrl: String(req.headers.referer || "").slice(0, 600),
      userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
      ip: String(req.ip || "").slice(0, 80),
      messages: [
        { from: "user", text: message },
        { from: "system", text: systemReply },
      ],
    });

    return res.redirect(`/support/${encodeURIComponent(t.publicId)}`);
  } catch (e) {
    console.error("support create error", e);
    return res.render("support", { error: "Failed to create ticket.", created: null });
  }
});

// Support thread (live)
r.get("/support/:publicId", async (req, res) => {
  const publicId = String(req.params.publicId || "").trim().toUpperCase();
  const ticket = await Ticket.findOne({ publicId }).lean();
  if (!ticket) return res.status(404).send("Not found");

  res.render("support_thread", { ticket });
});

// Checkout (your code, kept)
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

    let unitAmount = priceToHitProfit(
      baseCost,
      profit,
      { percent: feeModel.percent, fixed: feeModel.fixed },
      10
    );

    unitAmount = Math.round(Number(unitAmount || 0));
    if (!Number.isFinite(unitAmount) || unitAmount < 50) {
      return res.status(500).send("Pricing error");
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

    if (!session?.url) return res.status(500).send("Stripe session error");
    return res.redirect(303, session.url);
  } catch (e) {
    console.error("CHECKOUT ERROR:", e);
    return res.status(500).send("Checkout failed");
  }
});

export default r;
