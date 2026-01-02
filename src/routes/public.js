import { Router } from "express";
import { Product } from "../models/Product.js";
import { Code } from "../models/Code.js";
import { Settings } from "../models/Settings.js";
import { stripe } from "../config/stripe.js";
import {
  priceToHitProfit,
  stripeFeeForAmount,
  regionFromCountry,
  ALLOWED_SHIP_COUNTRIES,
} from "../config/money.js";

const r = Router();

/**
 * Currency exponent: how many decimal places Stripe expects.
 * Most are 2 (GBP, USD, EUR).
 * Some are 0 (JPY, KRW, VND, etc).
 * Add more if you need them.
 */
const ZERO_DECIMAL = new Set([
  "BIF","CLP","DJF","GNF","JPY","KMF","KRW","MGA","PYG","RWF","UGX","VND","VUV","XAF","XOF","XPF"
]);

function currencyExponent(currency) {
  const c = String(currency || "").toUpperCase();
  return ZERO_DECIMAL.has(c) ? 0 : 2;
}

function toMinor(amountMajor, currency) {
  // Convert e.g. 40.00 GBP -> 4000
  const exp = currencyExponent(currency);
  const n = Number(amountMajor);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** exp;
  return Math.round(n * factor);
}

function fromMaybeMinor(n) {
  // handles values coming as string/number
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function cleanUpper(s) {
  return String(s || "").toUpperCase().trim();
}

function cleanLower(s) {
  return String(s || "").toLowerCase().trim();
}

function pickBaseUrl(req) {
  // Prefer env, fallback to request host/proto
  const env = String(process.env.BASE_URL || "").trim();
  if (env) return env.replace(/\/+$/, "");

  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`.replace(/\/+$/, "");
}

/**
 * HOME
 */
r.get("/", async (req, res, next) => {
  try {
    const products = await Product.find({ active: true })
      .sort({ createdAt: -1 })
      .lean();

    res.render("store", { products });
  } catch (e) {
    next(e);
  }
});

/**
 * PRODUCT PAGE
 */
r.get("/p/:id", async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product || !product.active) return res.status(404).send("Not found");
    res.render("product", { product });
  } catch (e) {
    next(e);
  }
});

r.get("/success", (req, res) => res.render("success"));
r.get("/cancel", (req, res) => res.render("cancel"));

/**
 * CHECKOUT
 *
 * IMPORTANT:
 * - Your DB values (manufacturing/shipping/profit) are almost always stored as MAJOR units (e.g. £40.00).
 * - Stripe requires MINOR units (pence): 4000.
 *
 * If you pass major straight into Stripe, you get £0.40/£0.90 nonsense.
 */
r.post("/checkout", async (req, res, next) => {
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

    const quantity = Math.max(1, Math.min(10, Number(qty || 1) || 1));
    const countryUp = cleanUpper(country || "GB");
    const region = regionFromCountry(countryUp);

    const product = await Product.findById(productId).lean();
    if (!product || !product.active) return res.status(400).send("Bad product");

    const variant = (product.variants || []).find((v) => v.sku === variantSku);
    if (!variant) return res.status(400).send("Bad variant");

    const sizes = Array.isArray(variant.sizes) ? variant.sizes : [];
    if (sizes.length && !sizes.includes(size)) return res.status(400).send("Bad size");
    if (!variant.printfulVariantId) return res.status(400).send("Variant not configured");

    // Validate optional reference code
    if (referenceCode) {
      const ok = await Code.findOne({
        type: "reference",
        code: cleanUpper(referenceCode),
        active: true,
      }).lean();
      if (!ok) return res.status(400).send("Invalid reference code");
    }

    // Profit target (MAJOR)
    let profitMajor = fromMaybeMinor(variant.profit?.[region] ?? 0);
    if (profitMajor < 0) profitMajor = 0;

    // Referral discount affects profit target (still MAJOR)
    if (referralCode) {
      const c = await Code.findOne({
        type: "referral",
        code: cleanUpper(referralCode),
        active: true,
      }).lean();
      if (!c) return res.status(400).send("Invalid referral code");

      if (c.maxUses > 0 && c.used >= c.maxUses)
        return res.status(400).send("Referral code exhausted");

      const pct = Math.max(0, Math.min(90, Number(c.discountPercent || 0)));
      profitMajor = Math.max(0, profitMajor * (1 - pct / 100));
    }

    const settings = await Settings.findOne().lean();
    const feeModel =
      settings?.stripeFees?.[region] || settings?.stripeFees?.ROW;

    if (!feeModel?.currency) return res.status(500).send("Missing fee model currency");

    const currency = String(feeModel.currency).toUpperCase();

    // Base costs (MAJOR)
    const manufacturingMajor = fromMaybeMinor(variant.costs?.manufacturing ?? 0);
    const shipMajor = fromMaybeMinor(variant.costs?.shipping?.[region] ?? 0);
    const baseCostMajor = Math.max(0, manufacturingMajor + shipMajor);

    // Compute unit price (MAJOR) that hits profit (MAJOR)
    const unitPriceMajor = priceToHitProfit(
      baseCostMajor,
      profitMajor,
      { percent: feeModel.percent, fixed: feeModel.fixed },
      10
    );

    if (!Number.isFinite(unitPriceMajor) || unitPriceMajor <= 0) {
      return res.status(400).send("Pricing failed (invalid unit price)");
    }

    // Convert to Stripe MINOR units at the very end
    const unitAmountMinor = toMinor(unitPriceMajor, currency);

    // Safety checks
    if (unitAmountMinor < 50) {
      // basically prevents the “£0.90” disaster from ever going live again
      return res.status(400).send("Pricing too low (check your costs/profit settings)");
    }

    // Extra safety check: realized profit in MAJOR should be >= target
    // (stripeFeeForAmount expects same units as its input, so pass MAJOR here)
    const feeMajor = stripeFeeForAmount(unitPriceMajor, {
      percent: feeModel.percent,
      fixed: feeModel.fixed,
    });

    const realizedMajor = unitPriceMajor - feeMajor - baseCostMajor;
    if (realizedMajor + 1e-9 < profitMajor) {
      return res.status(400).send("Pricing safety check failed");
    }

    const baseUrl = pickBaseUrl(req);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email ? String(email).trim() : undefined,
      success_url: `${baseUrl}/success`,
      cancel_url: `${baseUrl}/cancel`,
      shipping_address_collection: { allowed_countries: ALLOWED_SHIP_COUNTRIES },
      line_items: [
        {
          quantity,
          price_data: {
            currency: currency.toLowerCase(),
            unit_amount: unitAmountMinor,
            product_data: {
              name: `Imprev Clothing - ${product.name}`,
              description: `${variant.name} | ${size}`,
              images: (product.images || []).slice(0, 1),
            },
          },
        },
      ],
      metadata: {
        productId: String(productId),
        variantSku: String(variantSku),
        size: String(size),
        qty: String(quantity),
        country: countryUp,
        region: String(region),

        referenceCode: cleanUpper(referenceCode),
        referralCode: cleanUpper(referralCode),

        // Store MAJOR + MINOR so you can debug without crying
        baseCostMajor: String(baseCostMajor),
        profitMajor: String(profitMajor),
        unitPriceMajor: String(unitPriceMajor),
        unitAmountMinor: String(unitAmountMinor),

        printfulVariantId: String(variant.printfulVariantId),
      },
    });

    if (!session?.url) {
      console.error("Stripe session created without url:", session?.id);
      return res.status(500).send("Checkout unavailable.");
    }

    return res.redirect(303, session.url);
  } catch (e) {
    console.error("CHECKOUT_ERR:", e?.message || e);
    // Stripe gives useful data sometimes:
    if (e?.raw) console.error("STRIPE_RAW:", e.raw);
    next(e);
  }
});

export default r;
