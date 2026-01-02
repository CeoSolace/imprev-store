import { Router } from "express";
import { Product } from "../models/Product.js";
import { Code } from "../models/Code.js";
import { Settings } from "../models/Settings.js";
import { stripe } from "../config/stripe.js";
import { regionFromCountry, ALLOWED_SHIP_COUNTRIES } from "../config/money.js";

const r = Router();

/**
 * Stripe unit_amount MUST be in minor units:
 * - GBP/EUR/USD => pennies/cents (2 decimals)
 * - JPY/KRW etc => 0 decimals
 */
function currencyFactor(currency) {
  const c = String(currency || "").toUpperCase();
  const zeroDecimal = new Set([
    "BIF","CLP","DJF","GNF","JPY","KMF","KRW","MGA","PYG","RWF","UGX","VND","VUV","XAF","XOF","XPF"
  ]);
  return zeroDecimal.has(c) ? 1 : 100;
}

function toMinor(amountMajor, currency) {
  const factor = currencyFactor(currency);
  const n = Number(amountMajor || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * factor);
}

function normalizePercent(p) {
  const n = Number(p || 0);
  if (!Number.isFinite(n)) return 0;
  // accepts 2.9 or 0.029
  return n > 1 ? n / 100 : n;
}

/**
 * Compute a unit_amount (minor units) that guarantees:
 * realized = amount - stripeFee(amount) - baseCost >= profit
 * baseCost/profit are in MINOR units.
 */
function priceToHitProfitMinor(baseCostMinor, profitMinor, feeModel, stepMinor = 10) {
  const currency = feeModel?.currency || "GBP";
  const percent = normalizePercent(feeModel?.percent);
  const fixedMinor = toMinor(feeModel?.fixed ?? 0, currency);

  const feeFor = (amountMinor) => Math.ceil(amountMinor * percent) + fixedMinor;

  // start at the obvious minimum
  let amount = baseCostMinor + profitMinor + fixedMinor;

  // round up to nice step (10p by default)
  if (stepMinor > 1) amount = Math.ceil(amount / stepMinor) * stepMinor;

  // bump until profit condition holds (should converge fast)
  for (let i = 0; i < 5000; i++) {
    const realized = amount - feeFor(amount) - baseCostMinor;
    if (realized >= profitMinor) return amount;

    amount += 1;
    if (stepMinor > 1 && amount % stepMinor !== 0) {
      amount = Math.ceil(amount / stepMinor) * stepMinor;
    }
  }

  // if we somehow fail, at least return something sane
  return amount;
}

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

r.post("/checkout", async (req, res) => {
  const { productId, variantSku, size, qty, country, referenceCode, referralCode, email } = req.body;

  const quantity = Math.max(1, Math.min(10, Number(qty || 1)));
  const region = regionFromCountry(country || "GB");

  const product = await Product.findById(productId).lean();
  if (!product || !product.active) return res.status(400).send("Bad product");

  const variant = (product.variants || []).find((v) => v.sku === variantSku);
  if (!variant) return res.status(400).send("Bad variant");
  if (!Array.isArray(variant.sizes) || !variant.sizes.includes(size)) return res.status(400).send("Bad size");
  if (!variant.printfulVariantId) return res.status(400).send("Variant not configured");

  // validate optional codes
  if (referenceCode) {
    const ok = await Code.findOne({
      type: "reference",
      code: referenceCode.toUpperCase().trim(),
      active: true,
    }).lean();
    if (!ok) return res.status(400).send("Invalid reference code");
  }

  // pull fee model
  const settings = await Settings.findOne().lean();
  const feeModel = settings?.stripeFees?.[region] || settings?.stripeFees?.ROW;
  if (!feeModel?.currency) return res.status(500).send("Stripe fee model missing");

  const currency = String(feeModel.currency).toLowerCase();

  // IMPORTANT: assume DB stores costs/profit in MAJOR units (e.g. 40.00 for £40)
  let profitMajor = Number(variant.profit?.[region] ?? 0);
  if (!Number.isFinite(profitMajor) || profitMajor < 0) profitMajor = 0;

  if (referralCode) {
    const c = await Code.findOne({
      type: "referral",
      code: referralCode.toUpperCase().trim(),
      active: true,
    }).lean();
    if (!c) return res.status(400).send("Invalid referral code");

    if (c.maxUses > 0 && c.used >= c.maxUses) return res.status(400).send("Referral code exhausted");

    const pct = Math.max(0, Math.min(90, Number(c.discountPercent || 0)));
    profitMajor = Math.max(0, profitMajor * (1 - pct / 100));
  }

  const manufacturingMajor = Number(variant.costs?.manufacturing ?? 0);
  const shipMajor = Number(variant.costs?.shipping?.[region] ?? 0);
  if (!Number.isFinite(manufacturingMajor) || !Number.isFinite(shipMajor)) {
    return res.status(400).send("Variant costs misconfigured");
  }

  const baseCostMajor = manufacturingMajor + shipMajor;

  // Convert to MINOR units for Stripe math
  const baseCostMinor = toMinor(baseCostMajor, feeModel.currency);
  const profitMinor = toMinor(profitMajor, feeModel.currency);

  // Choose rounding step: 10 minor units = 10p / €0.10 / $0.10
  // If you want exact pennies, set to 1.
  const unitAmount = priceToHitProfitMinor(baseCostMinor, profitMinor, feeModel, 10);

  // Safety check
  const percent = normalizePercent(feeModel.percent);
  const fixedMinor = toMinor(feeModel.fixed ?? 0, feeModel.currency);
  const fee = Math.ceil(unitAmount * percent) + fixedMinor;
  const realized = unitAmount - fee - baseCostMinor;
  if (realized < profitMinor) return res.status(400).send("Pricing safety check failed");

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: email || undefined,
    success_url: `${process.env.BASE_URL}/success`,
    cancel_url: `${process.env.BASE_URL}/cancel`,
    shipping_address_collection: { allowed_countries: ALLOWED_SHIP_COUNTRIES },
    line_items: [
      {
        quantity,
        price_data: {
          currency,
          unit_amount: unitAmount, // ✅ MINOR UNITS (pence/cents)
          product_data: {
            name: `Imprev Clothing - ${product.name}`,
            description: `${variant.name} | ${size}`,
            images: product.images?.slice(0, 1),
          },
        },
      },
    ],
    metadata: {
      productId,
      variantSku,
      size,
      qty: String(quantity),
      country: (country || "GB").toUpperCase(),
      region,
      referenceCode: (referenceCode || "").toUpperCase().trim(),
      referralCode: (referralCode || "").toUpperCase().trim(),
      // store both major + minor for debugging/audits
      baseCostMajor: String(baseCostMajor),
      profitMajor: String(profitMajor),
      baseCostMinor: String(baseCostMinor),
      profitMinor: String(profitMinor),
      unitAmountMinor: String(unitAmount),
      printfulVariantId: String(variant.printfulVariantId),
    },
  });

  return res.redirect(303, session.url);
});

export default r;
