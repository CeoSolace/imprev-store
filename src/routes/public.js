import { Router } from "express";
import { Product } from "../models/Product.js";
import { Code } from "../models/Code.js";
import { Settings } from "../models/Settings.js";
import { stripe } from "../config/stripe.js";
import { priceToHitProfit, stripeFeeForAmount, regionFromCountry, ALLOWED_SHIP_COUNTRIES } from "../config/money.js";

const r = Router();

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

  const variant = (product.variants || []).find(v => v.sku === variantSku);
  if (!variant) return res.status(400).send("Bad variant");
  if (!variant.sizes.includes(size)) return res.status(400).send("Bad size");
  if (!variant.printfulVariantId) return res.status(400).send("Variant not configured");

  // validate optional codes
  if (referenceCode) {
    const ok = await Code.findOne({ type: "reference", code: referenceCode.toUpperCase().trim(), active: true }).lean();
    if (!ok) return res.status(400).send("Invalid reference code");
  }

  let profit = Number(variant.profit?.[region] ?? 0);
  if (profit < 0) profit = 0;

  if (referralCode) {
    const c = await Code.findOne({ type: "referral", code: referralCode.toUpperCase().trim(), active: true }).lean();
    if (!c) return res.status(400).send("Invalid referral code");

    if (c.maxUses > 0 && c.used >= c.maxUses) return res.status(400).send("Referral code exhausted");

    const pct = Math.max(0, Math.min(90, Number(c.discountPercent || 0)));
    profit = Math.max(0, Math.floor(profit * (1 - pct / 100)));
  }

  const settings = await Settings.findOne().lean();
  const feeModel = settings?.stripeFees?.[region] || settings?.stripeFees?.ROW;
  const currency = feeModel.currency;

  const manufacturing = Number(variant.costs?.manufacturing ?? 0);
  const ship = Number(variant.costs?.shipping?.[region] ?? 0);
  const baseCost = manufacturing + ship;

  const unitAmount = priceToHitProfit(baseCost, profit, { percent: feeModel.percent, fixed: feeModel.fixed }, 10);

  // Safety check: verify realized profit >= target profit (with our rounding)
  const fee = stripeFeeForAmount(unitAmount, { percent: feeModel.percent, fixed: feeModel.fixed });
  const realized = unitAmount - fee - baseCost;
  if (realized < profit) return res.status(400).send("Pricing safety check failed");

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: email || undefined,
    success_url: `${process.env.BASE_URL}/success`,
    cancel_url: `${process.env.BASE_URL}/cancel`,
    shipping_address_collection: { allowed_countries: ALLOWED_SHIP_COUNTRIES },
    line_items: [{
      quantity,
      price_data: {
        currency: currency.toLowerCase(),
        unit_amount: unitAmount,
        product_data: {
          name: `Imprev Clothing - ${product.name}`,
          description: `${variant.name} | ${size}`,
          images: product.images?.slice(0, 1)
        }
      }
    }],
    metadata: {
      productId,
      variantSku,
      size,
      qty: String(quantity),
      country: (country || "GB").toUpperCase(),
      region,
      referenceCode: (referenceCode || "").toUpperCase().trim(),
      referralCode: (referralCode || "").toUpperCase().trim(),
      baseCost: String(baseCost),
      profit: String(profit),
      unitAmount: String(unitAmount),
      printfulVariantId: String(variant.printfulVariantId)
    }
  });

  res.redirect(303, session.url);
});

export default r;
