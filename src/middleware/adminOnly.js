import { verifyJwt } from "./jwt.js";

export function adminOnly(req, res, next) {
  const token = req.cookies?.admin_token;
  const data = verifyJwt(token);
  if (!data) return res.redirect("/admin/login");
  req.admin = data;
  next();
}
