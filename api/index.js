// Glane : toute la partie serveur dans un seul fichier.
// À placer dans le dépôt sous le nom api/index.js
const __mods = {};
const __load = (n) => (n.startsWith("./") ? __mods[n.slice(2)] : require(n));
function __def(name, fn) {
  const m = { exports: {} };
  fn(m, m.exports, __load);
  __mods[name] = m.exports;
}

// ===== _lib =====
__def("_lib", (module, exports, require) => {
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

});

// ===== _preview =====
__def("_preview", (module, exports, require) => {
// Lit une page web et en extrait l'image d'aperçu, le titre, le site et le prix
const UA_BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const UA_BOT = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

function timedFetch(url, opts = {}, ms = 6000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, redirect: "follow", signal: c.signal }).finally(() => clearTimeout(t));
}

const decode = (s) => String(s || "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ")
  .trim();

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } };

function metaReader(html) {
  const map = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1];
    if (key && val && !map[key.toLowerCase()]) map[key.toLowerCase()] = decode(val);
  }
  return (...keys) => {
    for (const k of keys) if (map[k]) return map[k];
    return null;
  };
}

function findProduct(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findProduct(n, depth + 1);
      if (f) return f;
    }
    return null;
  }
  const types = [].concat(node["@type"] || []);
  if (types.some((t) => /product/i.test(String(t)))) return node;
  if (node["@graph"]) return findProduct(node["@graph"], depth + 1);
  if (node.mainEntity) return findProduct(node.mainEntity, depth + 1);
  return null;
}

const firstImage = (img) => (!img ? null : typeof img === "string" ? img : Array.isArray(img) ? firstImage(img[0]) : img.url || img.contentUrl || null);

function parse(html, baseUrl) {
  const m = metaReader(html);
  let image = m("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src", "image");
  let title = m("og:title", "twitter:title") || decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const site = m("og:site_name", "application-name") || hostOf(baseUrl);
  let amount = m("product:price:amount", "og:price:amount", "price");
  let currency = m("product:price:currency", "og:price:currency", "pricecurrency");

  for (const block of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (image && amount) break;
    try {
      const p = findProduct(JSON.parse(block[1].trim()));
      if (!p) continue;
      if (!image) image = firstImage(p.image);
      if (!title && p.name) title = decode(p.name);
      const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
      if (offer && !amount) {
        amount = offer.price ?? offer.lowPrice ?? null;
        currency = offer.priceCurrency || currency;
      }
    } catch {
      // bloc JSON-LD illisible, on passe au suivant
    }
  }

  if (image) {
    try { image = new URL(decode(image), baseUrl).href; } catch { image = null; }
    if (image && !/^https?:\/\//i.test(image)) image = null;
  }
  return {
    title: title ? title.slice(0, 140) : null,
    image: image || null,
    site: site ? String(site).slice(0, 80) : null,
    price: amount ? `${amount}${currency ? " " + currency : ""}`.slice(0, 40) : null,
  };
}

async function getPreview(url) {
  const result = {};
  for (const ua of [UA_BROWSER, UA_BOT]) {
    try {
      const r = await timedFetch(url, {
        headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5", "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8" },
      });
      const ct = (r.headers.get("content-type") || "").split(";")[0].toLowerCase();
      if (ct.startsWith("image/") && !ct.includes("svg")) {
        return { imageDirect: true, image: r.url, buffer: Buffer.from(await r.arrayBuffer()), contentType: ct, site: hostOf(r.url) };
      }
      const html = (await r.text()).slice(0, 2000000);
      const p = parse(html, r.url);
      for (const k of Object.keys(p)) if (!result[k] && p[k]) result[k] = p[k];
      if (result.image) break;
    } catch {
      // site lent ou bloquant : on tente l'autre identité
    }
  }
  if (!result.site) result.site = hostOf(url);
  return result;
}

async function downloadImage(url, referer) {
  if (!/^https?:\/\//i.test(url || "")) return null;
  try {
    const r = await timedFetch(url, {
      headers: { "User-Agent": UA_BROWSER, Accept: "image/avif,image/webp,image/*,*/*;q=0.8", ...(referer ? { Referer: referer } : {}) },
    }, 7000);
    const ct = (r.headers.get("content-type") || "").split(";")[0].toLowerCase();
    if (!r.ok || !ct.startsWith("image/") || ct.includes("svg")) return null;
    const buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length < 500 || buffer.length > 8 * 1024 * 1024) return null;
    return { buffer, contentType: ct };
  } catch {
    return null;
  }
}

module.exports = { getPreview, downloadImage };

});

// ===== boards =====
__def("boards", (module, exports, require) => {
// /api/boards : lister, créer, modifier, supprimer les tableaux
const { db, guard, readBody, clip, UUID } = require("./_lib");

const HEX = /^#[0-9a-f]{6}$/i;

module.exports = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    if (req.method === "GET") {
      const boards = await db("boards?select=*&order=position.asc,created_at.asc");
      if (req.query.format === "lines") {
        // Format texte pour le Raccourci iPhone : une ligne par tableau
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        return res.send(boards.map((b) => `${b.emoji} ${b.name}`).concat(["📥 À trier"]).join("\n"));
      }
      return res.json({ boards });
    }

    if (req.method === "POST") {
      const b = readBody(req);
      const name = clip(b.name, 40);
      if (!name) return res.status(400).json({ error: "Nom manquant" });
      const existing = await db("boards?select=id");
      const [board] = await db("boards", {
        method: "POST",
        body: { name, emoji: clip(b.emoji, 8) || "✨", color: HEX.test(b.color || "") ? b.color : "#E3D3F7", position: existing.length },
      });
      return res.status(201).json({ board });
    }

    const id = String(req.query.id || "");
    if (!UUID.test(id)) return res.status(400).json({ error: "Identifiant invalide" });

    if (req.method === "PATCH") {
      const b = readBody(req);
      const patch = {};
      if (clip(b.name, 40)) patch.name = clip(b.name, 40);
      if (clip(b.emoji, 8)) patch.emoji = clip(b.emoji, 8);
      if (HEX.test(b.color || "")) patch.color = b.color;
      const [board] = await db(`boards?id=eq.${id}`, { method: "PATCH", body: patch });
      return res.json({ board });
    }

    if (req.method === "DELETE") {
      // Les contenus du tableau passent dans « À trier » (clé étrangère ON DELETE SET NULL)
      await db(`boards?id=eq.${id}`, { method: "DELETE" });
      return res.json({ ok: true });
    }

    res.status(405).json({ error: "Méthode non autorisée" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

});

// ===== items =====
__def("items", (module, exports, require) => {
// /api/items : lister, créer (lien, image, texte), modifier, supprimer les contenus
const crypto = require("crypto");
const { db, uploadImage, deleteImage, guard, readBody, clip, norm, UUID } = require("./_lib");
const { getPreview, downloadImage } = require("./_preview");

function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.slice(0, 3).toString() === "GIF") return "image/gif";
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  if (buf.slice(4, 12).toString().includes("ftyphei")) return "image/heic";
  return "image/jpeg";
}

async function resolveBoard(b) {
  if (b.board_id && UUID.test(b.board_id)) return b.board_id;
  const wanted = norm(b.board);
  if (!wanted) return null;
  const boards = await db("boards?select=id,name,emoji");
  const found = boards.find((x) => norm(x.name) === wanted || norm(`${x.emoji} ${x.name}`) === wanted);
  return found ? found.id : null;
}

async function create(req, res) {
  const b = readBody(req);
  const id = crypto.randomUUID();
  const row = { id, board_id: await resolveBoard(b), title: clip(b.title, 140), note: clip(b.note, 1000) };

  const b64 = typeof b.image_base64 === "string" ? b.image_base64.replace(/^data:[^,]+,/, "").replace(/\s+/g, "") : "";
  const text = typeof b.text === "string" ? b.text.trim() : "";
  let url = typeof b.url === "string" ? b.url.trim() : "";

  // Un partage Android ou un Raccourci envoie souvent « Regarde ça https://… » : on isole le lien
  if (!url && text) {
    const m = text.match(/https?:\/\/[^\s<>"]+/);
    if (m && text.replace(m[0], "").trim().length < 120) url = m[0].replace(/[)\].,;!?»"']+$/, "");
  }

  if (b64) {
    const buffer = Buffer.from(b64, "base64");
    if (buffer.length < 100) return res.status(400).json({ error: "Image illisible" });
    const up = await uploadImage(buffer, sniff(buffer), id);
    Object.assign(row, { type: "image", image_url: up.url, image_path: up.path });
  } else if (url) {
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Lien invalide" });
    row.url = url.slice(0, 2000);
    const hint = b.preview && typeof b.preview === "object" && b.preview.image && !b.preview.isImage ? b.preview : null;
    const p = hint || (await getPreview(url));

    if (p.imageDirect) {
      const up = await uploadImage(p.buffer, p.contentType, id);
      Object.assign(row, { type: "image", image_url: up.url, image_path: up.path, site: clip(p.site, 80) });
    } else {
      row.type = "link";
      row.site = clip(p.site, 80);
      row.price = clip(p.price, 40);
      if (!row.title) row.title = clip(p.title, 140);
      if (p.image) {
        // On copie l'image chez nous pour qu'elle reste visible même si le site la change
        const img = await downloadImage(p.image, url);
        if (img) {
          const up = await uploadImage(img.buffer, img.contentType, id);
          row.image_url = up.url;
          row.image_path = up.path;
        } else {
          row.image_url = p.image;
        }
      }
    }
  } else if (text) {
    row.type = "text";
    row.text = text.slice(0, 5000);
  } else {
    return res.status(400).json({ error: "Rien à enregistrer" });
  }

  const [saved] = await db("items", { method: "POST", body: row });
  res.status(201).json({ item: saved });
}

module.exports = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    if (req.method === "GET") {
      const items = await db("items?select=*&order=created_at.desc&limit=1000");
      return res.json({ items });
    }
    if (req.method === "POST") return await create(req, res);

    const id = String(req.query.id || "");
    if (!UUID.test(id)) return res.status(400).json({ error: "Identifiant invalide" });

    if (req.method === "PATCH") {
      const b = readBody(req);
      const patch = {};
      if ("title" in b) patch.title = clip(b.title, 140);
      if ("note" in b) patch.note = clip(b.note, 1000);
      if ("text" in b && clip(b.text, 5000)) patch.text = clip(b.text, 5000);
      if ("board_id" in b) patch.board_id = b.board_id && UUID.test(b.board_id) ? b.board_id : null;
      const [item] = await db(`items?id=eq.${id}`, { method: "PATCH", body: patch });
      return res.json({ item });
    }

    if (req.method === "DELETE") {
      const [item] = await db(`items?id=eq.${id}`, { method: "DELETE" });
      if (item) await deleteImage(item.image_path);
      return res.json({ ok: true });
    }

    res.status(405).json({ error: "Méthode non autorisée" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

});

// ===== preview =====
__def("preview", (module, exports, require) => {
// GET /api/preview?url=...  : aperçu d'un lien (image, titre, site, prix) avant de le ranger
const { guard } = require("./_lib");
const { getPreview } = require("./_preview");

module.exports = async (req, res) => {
  if (!guard(req, res)) return;
  const url = String((req.query && req.query.url) || "");
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Lien invalide" });
  const p = await getPreview(url);
  res.json({
    title: p.title || null,
    image: p.image || null,
    site: p.site || null,
    price: p.price || null,
    isImage: !!p.imageDirect,
  });
};

});

// ===== Aiguillage : /api/boards, /api/items, /api/preview =====
module.exports = async (req, res) => {
  const route = String((req.query && req.query.route) || "").replace(/^\/+|\/+$/g, "");
  const handler = { boards: __mods.boards, items: __mods.items, preview: __mods.preview }[route];
  if (!handler) return res.status(404).json({ error: "Route inconnue" });
  return handler(req, res);
};
