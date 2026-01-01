import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

export async function uploadImageBuffer(buffer, filename = "image") {
  const folder = process.env.CLOUDINARY_FOLDER || "imprev-clothing";
  const b64 = buffer.toString("base64");
  // assume jpeg/png, Cloudinary can sniff content
  const dataUri = `data:application/octet-stream;base64,${b64}`;

  const res = await cloudinary.uploader.upload(dataUri, {
    folder,
    public_id: `${Date.now()}_${sanitize(filename)}`,
    resource_type: "image"
  });

  return res.secure_url;
}

function sanitize(name) {
  return String(name || "img").replace(/[^a-z0-9._-]/gi, "_").slice(0, 80);
}
