import { Router } from "express";
import { Store } from "../models/Store.js";
import { Product } from "../models/Product.js";

const r = Router();

r.get("/discover", async (req, res) => {
  const stores = await Store.find().sort({ createdAt: -1 }).lean();
  res.render("discover", { stores });
});

r.get("/@:slug", async (req, res) => {
  const store = await Store.findOne({ slug: req.params.slug }).lean();

  if (!store) {
    return res.status(404).send("Store not found");
  }

  const products = await Product.find({
    storeId: store._id,
    active: true
  })
    .sort({ createdAt: -1 })
    .lean();

  res.render("storefront", {
    store,
    products
  });
});

export default r;
