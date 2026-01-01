import mongoose from "mongoose";

const FeeSchema = new mongoose.Schema({
  currency: { type: String, required: true },
  percent: { type: Number, required: true },
  fixed: { type: Number, required: true }
}, { _id: false });

const SettingsSchema = new mongoose.Schema({
  stripeFees: {
    UK: { type: FeeSchema, required: true },
    EU: { type: FeeSchema, required: true },
    US: { type: FeeSchema, required: true },
    TR: { type: FeeSchema, required: true },
    ROW: { type: FeeSchema, required: true }
  }
}, { timestamps: true });

export const Settings = mongoose.model("Settings", SettingsSchema);

export async function ensureSettings() {
  const s = await Settings.findOne();
  if (s) return;

  await Settings.create({
    stripeFees: {
      UK: { currency: "GBP", percent: 0.029, fixed: 30 },
      EU: { currency: "EUR", percent: 0.029, fixed: 30 },
      US: { currency: "USD", percent: 0.029, fixed: 30 },
      TR: { currency: "TRY", percent: 0.029, fixed: 30 },
      ROW:{ currency: "USD", percent: 0.029, fixed: 30 }
    }
  });
}
