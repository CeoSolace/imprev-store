import mongoose from "mongoose";

const VariantSchema = new mongoose.Schema({
  sku: { type: String, required: true },
  name: { type: String, required: true },
  sizes: { type: [String], default: [] },
  printfulVariantId: { type: Number, required: true },

  costs: {
    manufacturing: { type: Number, required: true }, // minor units
    shipping: {
      UK: { type: Number, required: true },
      EU: { type: Number, required: true },
      US: { type: Number, required: true },
      TR: { type: Number, required: true },
      ROW:{ type: Number, required: true }
    }
  },

  profit: {
    UK: { type: Number, required: true },
    EU: { type: Number, required: true },
    US: { type: Number, required: true },
    TR: { type: Number, required: true },
    ROW:{ type: Number, required: true }
  }
}, { _id: false });

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: "" },
  images: { type: [String], default: [] },
  active: { type: Boolean, default: false },
  variants: { type: [VariantSchema], default: [] }
}, { timestamps: true });

export const Product = mongoose.model("Product", ProductSchema);
