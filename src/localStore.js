import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const ROOT = process.env.LOCAL_DATA_DIR || path.join(process.cwd(), "data");

const COLLECTIONS = [
  "stores",
  "follows",
  "feedEvents",
  "announcements",
  "notifications",
  "drops",
  "subscriptions",
  "analytics"
];

function fileFor(collection) {
  return path.join(ROOT, `${collection}.json`);
}

async function ensureCollection(collection) {
  await fs.mkdir(ROOT, { recursive: true });

  const file = fileFor(collection);

  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, "[]", "utf8");
  }
}

export async function initLocalStore() {
  for (const collection of COLLECTIONS) {
    await ensureCollection(collection);
  }

  console.log(`Local VPS storage ready at ${ROOT}`);
}

export async function readLocal(collection) {
  await ensureCollection(collection);

  const raw = await fs.readFile(fileFor(collection), "utf8");

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writeLocal(collection, rows) {
  await ensureCollection(collection);

  const safeRows = Array.isArray(rows) ? rows : [];
  const tmp = `${fileFor(collection)}.tmp`;

  await fs.writeFile(tmp, JSON.stringify(safeRows, null, 2), "utf8");
  await fs.rename(tmp, fileFor(collection));
}

export async function insertLocal(collection, data) {
  const rows = await readLocal(collection);

  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    ...data,
    createdAt: now,
    updatedAt: now
  };

  rows.unshift(row);
  await writeLocal(collection, rows);

  return row;
}

export async function updateLocal(collection, id, patch) {
  const rows = await readLocal(collection);

  const now = new Date().toISOString();
  const updated = rows.map((row) => {
    if (row.id !== id) return row;

    return {
      ...row,
      ...patch,
      updatedAt: now
    };
  });

  await writeLocal(collection, updated);

  return updated.find((row) => row.id === id) || null;
}

export async function removeLocal(collection, id) {
  const rows = await readLocal(collection);
  const updated = rows.filter((row) => row.id !== id);
  await writeLocal(collection, updated);
  return rows.length !== updated.length;
}

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
