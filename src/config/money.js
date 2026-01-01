export function priceToHitProfit(baseCost, profit, fee, roundTo = 10) {
  const { percent, fixed } = fee;
  if (baseCost < 0 || profit < 0) throw new Error("Invalid baseCost/profit");
  if (typeof percent !== "number" || percent < 0 || percent >= 1) throw new Error("Invalid percent");
  if (typeof fixed !== "number" || fixed < 0) throw new Error("Invalid fixed fee");

  const raw = (baseCost + profit + fixed) / (1 - percent);
  return Math.ceil(raw / roundTo) * roundTo; // round UP so you never undercharge
}

export function stripeFeeForAmount(amount, fee) {
  // Stripe takes percent + fixed. Percent component rounding varies; this is a safe approximation for profit guarantee,
  // because we ROUND UP the retail price.
  return Math.round(amount * fee.percent) + fee.fixed;
}

export function regionFromCountry(cc) {
  const c = (cc || "").toUpperCase();
  if (c === "GB") return "UK";
  const EU = new Set([
    "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT",
    "LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE"
  ]);
  if (EU.has(c)) return "EU";
  if (c === "US") return "US";
  if (c === "TR") return "TR";
  return "ROW";
}

export const ALLOWED_SHIP_COUNTRIES = [
  "GB","US","CA","AU","NZ","TR",
  "IE","FR","DE","ES","IT","NL","SE","NO","DK","FI","BE","AT","PL","PT","GR","RO","HU","CZ","SK","SI","HR","BG","CY","LV","LT","EE","LU","MT"
];
