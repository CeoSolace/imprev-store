import { Router } from "express";
import {
  insertLocal,
  readLocal,
  slugify
} from "../localStore.js";

const r = Router();

const MONTHLY_PRICE = 2.5;

r.get("/builder", async (req, res) => {
  const stores = await readLocal("stores");

  res.render("builder", {
    monthlyPrice: MONTHLY_PRICE,
    stores
  });
});

r.post("/builder/create", async (req, res) => {
  const {
    name,
    email,
    category,
    bio
  } = req.body;

  if (!name || !email) {
    return res.status(400).send("Missing required fields");
  }

  const slug = slugify(name);

  const store = await insertLocal("stores", {
    name,
    email,
    category: category || "creator",
    bio: bio || "",
    slug,
    featured: false,
    verified: false,
    plan: {
      type: "hosted",
      monthlyPrice: MONTHLY_PRICE,
      contract: false
    }
  });

  return res.redirect(`/stores/@${store.slug}`);
});

export default r;
