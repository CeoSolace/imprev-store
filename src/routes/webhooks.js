import { Router } from "express";
import { rawJson } from "../middleware/rawBody.js";
import { stripe } from "../config/stripe.js";
import { Order } from "../models/Order.js";
import { Code } from "../models/Code.js";
import { printfulCreateOrder } from "../config/printful.js";

const r = Router();

r.post("/stripe", rawJson, async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook error: ${e.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const exists = await Order.findOne({ stripeSessionId: session.id }).lean();
    if (!exists) {
      const meta = session.metadata || {};
      const ship = session.shipping_details?.address || {};

      const order = await Order.create({
        stripeSessionId: session.id,
        status: "paid",
        email: session.customer_details?.email || null,
        currency: (session.currency || "").toUpperCase(),
        amountTotal: session.amount_total || 0,
        referenceCode: meta.referenceCode || "",
        referralCode: meta.referralCode || "",
        shipping: {
          name: session.shipping_details?.name || "",
          line1: ship.line1 || "",
          line2: ship.line2 || "",
          city: ship.city || "",
          state: ship.state || "",
          postal: ship.postal_code || "",
          country: ship.country || ""
        },
        items: [{
          productId: meta.productId,
          variantSku: meta.variantSku,
          size: meta.size,
          qty: Number(meta.qty || 1),
          region: meta.region,
          baseCost: Number(meta.baseCost || 0),
          profit: Number(meta.profit || 0),
          unitAmount: Number(meta.unitAmount || 0),
          printfulVariantId: Number(meta.printfulVariantId || 0)
        }]
      });

      // mark referral code used (after a paid session)
      if (order.referralCode) {
        await Code.updateOne(
          { type: "referral", code: order.referralCode.toUpperCase().trim(), active: true },
          { $inc: { used: 1 } }
        );
      }

      try {
        const recipient = {
          name: order.shipping.name,
          address1: order.shipping.line1,
          address2: order.shipping.line2 || "",
          city: order.shipping.city,
          state_code: order.shipping.state || "",
          zip: order.shipping.postal,
          country_code: order.shipping.country,
          email: order.email || ""
        };

        const items = order.items.map(i => ({
          variant_id: i.printfulVariantId,
          quantity: i.qty
        }));

        const pf = await printfulCreateOrder({ recipient, items });

        order.status = "fulfilled";
        order.printfulOrderId = String(pf?.result?.id || "");
        await order.save();
      } catch (e) {
        order.status = "failed";
        await order.save();
        console.error("Printful fulfill failed:", e);
      }
    }
  }

  res.json({ received: true });
});

export default r;
