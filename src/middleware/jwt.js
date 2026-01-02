import crypto from "crypto";

function base64url(s) {
  return Buffer.from(s).toString("base64url");
}

export function signJwt(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing");

  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");

  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token) {
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;

    const [h, b, s] = String(token || "").split(".");
    if (!h || !b || !s) return null;

    const sig = crypto
      .createHmac("sha256", secret)
      .update(`${h}.${b}`)
      .digest("base64url");

    if (sig !== s) return null;

    const json = Buffer.from(b, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}
