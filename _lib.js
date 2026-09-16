// Utilitaires partagés par les fonctions serveur (les fichiers commençant par _ ne sont pas exposés par Vercel)
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET = "glane";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sbHeaders(extra = {}) {
  const h = { apikey: SB_KEY, ...extra };
  // Les anciennes clés (JWT) passent aussi en Bearer ; les nouvelles clés sb_secret_ passent par apikey
  if (!SB_KEY.startsWith("sb_")) h.Authorization = `Bearer ${SB_KEY}`;
  return h;
}

async function db(path, { method = "GET", body } = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: sbHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Base de données (${r.status}) : ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

async function uploadImage(buffer, contentType, name) {
  const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/heic": "heic" })[contentType] || "jpg";
  const path = `${name}.${ext}`;
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: sbHeaders({ "Content-Type": contentType, "x-upsert": "true" }),
    body: buffer,
  });
  if (!r.ok) throw new Error(`Stockage (${r.status}) : ${(await r.text()).slice(0, 200)}`);
  return { path, url: `${SB_URL}/storage/v1/object/public/${BUCKET}/${path}` };
}

async function deleteImage(path) {
  if (!path) return;
  try {
    await fetch(`${SB_URL}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: sbHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prefixes: [path] }),
    });
  } catch {
    // l'image restera dans le stockage, sans conséquence
  }
}

function guard(req, res) {
  if (!SB_URL || !SB_KEY || !process.env.GLANE_CODE) {
    res.status(500).json({ error: "Variables d'environnement manquantes sur Vercel (SUPABASE_URL, SUPABASE_SECRET_KEY, GLANE_CODE)" });
    return false;
  }
  const code = req.headers["x-glane-code"] || (req.query && req.query.code);
  if (code !== process.env.GLANE_CODE) {
    res.status(401).json({ error: "Code invalide" });
    return false;
  }
  return true;
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

const clip = (s, n) => (typeof s === "string" && s.trim() ? s.trim().slice(0, n) : null);
const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

module.exports = { db, uploadImage, deleteImage, guard, readBody, clip, norm, UUID };
