import { Router } from "express";
import { Product } from "../models/Product.js";
import { Settings } from "../models/Settings.js";
import { stripe } from "../config/stripe.js";
import {
  priceToHitProfit,
  regionFromCountry,
  ALLOWED_SHIP_COUNTRIES,
} from "../config/money.js";

const r = Router();

/* ---------------- BASE URL ---------------- */
function getBaseUrl(req) {
  const envUrl = (process.env.BASE_URL || "").trim();
  if (envUrl) return envUrl.replace(/\/+$/, "");

  const proto =
    String(req.headers["x-forwarded-proto"] || "")
      .split(",")[0]
      .trim() || (req.secure ? "https" : "http");

  return `${proto}://${req.headers.host}`;
}

/* ---------------- STORE ---------------- */
r.get("/", async (req, res) => {
  const products = await Product.find({ active: true })
    .sort({ createdAt: -1 })
    .lean();
  res.render("store", { products });
});

r.get("/p/:id", async (req, res) => {
  const product = await Product.findById(req.params.id).lean();
  if (!product || !product.active) return res.status(404).send("Not found");
  res.render("product", { product });
});

r.get("/success", (req, res) => res.render("success"));
r.get("/cancel", (req, res) => res.render("cancel"));

/* ---------------- HIRING ---------------- */
r.get("/hiring", (req, res) => {
  res.render("hiring", { sent: req.query.sent === "1" });
});

r.post("/apply", async (req, res) => {
  try {
    const { name, email, discord, role, experience, message, resumeLink } = req.body;

    // Validate required fields
    if (!name || !email || !role || !experience || !message || !resumeLink) {
      return res.status(400).send("Missing required fields");
    }

    // Validate email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).send("Invalid email format");

    // Validate resume link
    try {
      const url = new URL(resumeLink);
      if (!url.protocol.startsWith("http")) throw new Error();
    } catch {
      return res.status(400).send("Invalid resume link URL");
    }

    // Discord embed payload
    const payload = {
      embeds: [
        {
          title: "📥 New Volunteer Application",
          color: 0x2f3136,
          fields: [
            { name: "Name", value: name, inline: true },
            { name: "Role", value: role, inline: true },
            { name: "Email", value: email },
            { name: "Discord", value: discord || "N/A" },
            { name: "Experience", value: experience.slice(0, 1000) },
            { name: "Message", value: message.slice(0, 1000) },
            { name: "Resume", value: resumeLink },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    };

    const resp = await fetch(
      `https://discord.com/api/v10/channels/${process.env.CHANNEL_ID_APP}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.error("DISCORD ERROR:", text);
      return res.status(500).send("Failed to send application to Discord");
    }

    res.redirect("/hiring?sent=1");
  } catch (err) {
    console.error("APPLICATION ERROR:", err);
    res.status(500).send(err.message || "Failed to submit application");
  }
});

/* ---------------- CHECKOUT ---------------- */
r.post("/checkout", async (req, res) => {
  try {
    const { productId, variantSku, size, qty, country, email } = req.body;

    const quantity = Math.max(1, Math.min(10, Number(qty || 1)));
    const region = regionFromCountry(country || "GB");

    const product = await Product.findById(productId).lean();
    if (!product || !product.active) return res.status(400).send("Bad product");

    const variant = (product.variants || []).find((v) => v.sku === variantSku);
    if (!variant) return res.status(400).send("Bad variant");

    const normSize = String(size || "").trim();
    if (!normSize) return res.status(400).send("Bad size");

    if (!variant.printfulVariantId) return res.status(400).send("Variant not configured");

    let profit = Number(variant.profit?.[region] ?? 0);
    if (!Number.isFinite(profit) || profit < 0) profit = 0;

    const settings = await Settings.findOne().lean();
    const feeModel = settings?.stripeFees?.[region] || settings?.stripeFees?.ROW;
    if (!feeModel) return res.status(500).send("Stripe fee model missing");

    const manufacturing = Number(variant.costs?.manufacturing ?? 0);
    const ship = Number(variant.costs?.shipping?.[region] ?? 0);
    const baseCost = manufacturing + ship;

    let unitAmount = priceToHitProfit(
      baseCost,
      profit,
      { percent: feeModel.percent, fixed: feeModel.fixed },
      10
    );
    unitAmount = Math.round(unitAmount);

    if (!Number.isFinite(unitAmount) || unitAmount < 50) {
      return res.status(500).send("Pricing error");
    }

    const baseUrl = getBaseUrl(req);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email || undefined,
      success_url: `${baseUrl}/success`,
      cancel_url: `${baseUrl}/cancel`,
      shipping_address_collection: {
        allowed_countries: ALLOWED_SHIP_COUNTRIES,
      },
      line_items: [
        {
          quantity,
          price_data: {
            currency: feeModel.currency.toLowerCase(),
            unit_amount: unitAmount,
            product_data: {
              name: `Imprev Clothing - ${product.name}`,
              description: `${variant.name} | ${normSize}`,
              images: product.images?.slice(0, 1),
            },
          },
        },
      ],
    });

    if (!session?.url) return res.status(500).send("Stripe session error");

    res.redirect(303, session.url);
  } catch (e) {
    console.error("CHECKOUT ERROR:", e);
    res.status(500).send("Checkout failed");
  }
});

export default r;
