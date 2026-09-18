// Glane : the whole server in a single file.
// Lives in the repository as api/index.js
const __mods = {};
const __load = (n) => (n.startsWith("./") ? __mods[n.slice(2)] : require(n));
function __def(name, fn) {
  const m = { exports: {} };
  fn(m, m.exports, __load);
  __mods[name] = m.exports;
}

// ===== _lib =====
__def("_lib", (module, exports, require) => {
// Utilitaires partagés : accès Supabase, stockage des images, comptes utilisateurs
const crypto = require("crypto");

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET = "glane";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_BOARDS = [
  { name: "Fashion", slug: "fashion", emoji: "shirt", color: "#D9D6CF", kind: "collection", tagset: null },
  { name: "Food", slug: "food", emoji: "utensils", color: "#D6CCBC", kind: "collection", tagset: null },
  { name: "Reading", slug: "reading", emoji: "book", color: "#C9CCBC", kind: "collection", tagset: null },
  { name: "Quotes", slug: "quotes", emoji: "quote", color: "#C8CED3", kind: "collection", tagset: null },
  { name: "Fitness", slug: "fitness", emoji: "dumbbell", color: "#BFC7C3", kind: "collection", tagset: "muscles" },
  { name: "Spiritual", slug: "spiritual", emoji: "leaf", color: "#D0C8BD", kind: "collection", tagset: null },
  { name: "Events", slug: "events", emoji: "calendar", color: "#DDD8CE", kind: "events", tagset: null },
  { name: "Spots to test", slug: "spots", emoji: "pin", color: "#CFC3B8", kind: "places", tagset: "places" },
  { name: "To-do", slug: "todo", emoji: "checklist", color: "#D3D6CC", kind: "todo", tagset: null },
];

function sbHeaders(extra = {}) {
  const h = { apikey: SB_KEY, ...extra };
  // Les anciennes clés (JWT) passent aussi en Bearer ; les nouvelles clés sb_secret_ passent par apikey
  if (!SB_KEY.startsWith("sb_") && !h.Authorization) h.Authorization = `Bearer ${SB_KEY}`;
  return h;
}

async function db(path, { method = "GET", body } = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: sbHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Database error (${r.status}): ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

// Appels au service de comptes de Supabase (Auth)
async function authFetch(path, { method = "POST", body, token } = {}) {
  const headers = sbHeaders({ "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) });
  const r = await fetch(`${SB_URL}/auth/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let data = {};
  try { data = t ? JSON.parse(t) : {}; } catch { data = {}; }
  return { ok: r.ok, status: r.status, data };
}

async function uploadImage(buffer, contentType, name) {
  const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/heic": "heic" })[contentType] || "jpg";
  const path = `${name}.${ext}`;
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: sbHeaders({ "Content-Type": contentType, "x-upsert": "true" }),
    body: buffer,
  });
  if (!r.ok) throw new Error(`Storage error (${r.status}): ${(await r.text()).slice(0, 200)}`);
  return { path, url: `${SB_URL}/storage/v1/object/public/${BUCKET}/${path}` };
}

async function deleteImages(paths) {
  const list = (paths || []).filter(Boolean);
  for (let i = 0; i < list.length; i += 100) {
    try {
      await fetch(`${SB_URL}/storage/v1/object/${BUCKET}`, {
        method: "DELETE",
        headers: sbHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ prefixes: list.slice(i, i + 100) }),
      });
    } catch {
      // les images resteront dans le stockage, sans conséquence
    }
  }
}
const deleteImage = (path) => deleteImages([path]);

function configured(res) {
  if (!SB_URL || !SB_KEY) {
    res.status(500).json({ error: "Missing environment variables on Vercel (SUPABASE_URL, SUPABASE_SECRET_KEY)" });
    return false;
  }
  return true;
}

// Qui fait la requête ? Soit l'app (jeton de session), soit un Raccourci (clé de partage personnelle)
async function currentUser(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(\S+)$/i);
  if (m) {
    const r = await authFetch("user", { method: "GET", token: m[1] });
    return r.ok && r.data && r.data.id ? { id: r.data.id, email: r.data.email || null, token: m[1], viaKey: false } : null;
  }
  const key = String(req.headers["x-glane-key"] || (req.query && req.query.key) || "");
  if (/^[A-Za-z0-9_-]{24,64}$/.test(key)) {
    const rows = await db(`profiles?share_key=eq.${key}&select=user_id`);
    if (rows.length) return { id: rows[0].user_id, email: null, token: null, viaKey: true };
  }
  return null;
}

async function requireUser(req, res) {
  if (!configured(res)) return null;
  const user = await currentUser(req);
  if (!user) {
    res.status(401).json({ error: "Please sign in again" });
    return null;
  }
  return user;
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

const newKey = () => crypto.randomBytes(24).toString("base64url");
const validDate = (d) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
const clip = (s, n) => (typeof s === "string" && s.trim() ? s.trim().slice(0, n) : null);
const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\p{Extended_Pictographic}|\uFE0F/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

module.exports = {
  db, authFetch, uploadImage, deleteImage, deleteImages, configured, currentUser, requireUser,
  readBody, newKey, validDate, clip, norm, UUID, DEFAULT_BOARDS,
};

});

// ===== _preview =====
__def("_preview", (module, exports, require) => {
// Lit une page web et en extrait l'image d'aperçu, le titre, le site et le prix
const UA_BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const UA_BOT = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

function timedFetch(url, opts = {}, ms = 6000) {
  // Le minuteur n'est pas annulé à la réception des en-têtes : il limite aussi la lecture du contenu
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  if (t.unref) t.unref();
  return fetch(url, { ...opts, redirect: "follow", signal: c.signal });
}

const decode = (s) => String(s || "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ")
  .trim();

// Titres typiques des pages anti-robot (Cloudflare, Akamai, etc.)
const BLOCKED = /^\s*(access denied|just a moment|attention required|403 forbidden|forbidden|are you a robot|pardon our interruption|verify you are human|robot check|request unsuccessful|security check|captcha|not acceptable|site maintenance|page not found|service unavailable|bad gateway|error\s*\d{3}|\d{3}\s*(error|forbidden|not found))\s*($|[|:!.\u2013\u2014-])/i;

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
  let title = m("og:title", "twitter:title");
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

  // Ordre de préférence du titre : balises d'aperçu, puis nom du produit, puis titre de la page
  if (!title) title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
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

function titleFromUrl(u) {
  try {
    const segs = decodeURIComponent(new URL(u).pathname).split("/").filter(Boolean)
      .map((x) => x
        .replace(/\.[a-z0-9]{2,5}$/i, "")
        .replace(/--?id\d+/gi, "")
        .replace(/\b[a-z]*\d{5,}[a-z0-9]*\b/gi, "")
        .replace(/[-_+]+/g, " ")
        .trim())
      .filter((x) => x.length > 2 && /[a-z]/i.test(x)
        && !(/\d/.test(x) && !/\s/.test(x) && x.length >= 6)
        && !/^[a-z]{2}(\s[a-z]{2})?$/i.test(x)
        && !/^(dp|product|products|item|items|shop|store|html|index|detail|details|collections?)$/i.test(x));
    const pick = segs.slice(-2).join(" · ");
    return pick ? pick.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 100) : null;
  } catch {
    return null;
  }
}

// Service tiers gratuit (quota limité) qui sait souvent passer là où une requête simple est bloquée
async function microlink(url) {
  try {
    const r = await timedFetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, { headers: { Accept: "application/json" } }, 8000);
    if (!r.ok) return {};
    const j = await r.json();
    if (j.status !== "success" || !j.data) return {};
    const d = j.data;
    if (d.title && BLOCKED.test(d.title)) return {};
    const image = d.image && /^https?:\/\//i.test(d.image.url || "") ? d.image.url : null;
    return {
      title: d.title ? decode(d.title).slice(0, 140) : null,
      image,
      site: d.publisher ? String(d.publisher).slice(0, 80) : null,
    };
  } catch {
    return {};
  }
}

async function getPreview(url) {
  const result = {};
  for (const ua of [UA_BROWSER, UA_BOT]) {
    try {
      const r = await timedFetch(url, {
        headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5", "Accept-Language": "en-GB,en;q=0.9,fr;q=0.8" },
      }, 5000);
      const ct = (r.headers.get("content-type") || "").split(";")[0].toLowerCase();
      if (r.ok && ct.startsWith("image/") && !ct.includes("svg")) {
        return { imageDirect: true, image: r.url, buffer: Buffer.from(await r.arrayBuffer()), contentType: ct, site: hostOf(r.url) };
      }
      if (!result.finalUrl) result.finalUrl = r.url;
      if (r.status >= 400) continue;
      const html = (await r.text()).slice(0, 2000000);
      const p = parse(html, r.url);
      if (p.title && BLOCKED.test(p.title)) continue; // page de blocage : on ignore tout
      for (const k of Object.keys(p)) if (!result[k] && p[k]) result[k] = p[k];
      if (result.image) break;
    } catch {
      // site lent ou bloquant : on tente la suite
    }
  }
  if (!result.image || !result.title) {
    const m = await microlink(url);
    for (const k of Object.keys(m)) if (!result[k] && m[k]) result[k] = m[k];
  }
  if (!result.title) result.title = titleFromUrl(url);
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

module.exports = { getPreview, downloadImage, BLOCKED, titleFromUrl, timedFetch };

});

// ===== _geo =====
__def("_geo", (module, exports, require) => {
// Position d'un lieu : lue dans un lien Google Maps / Apple Maps, sinon cherchée par nom (OpenStreetMap)
const { timedFetch } = require("./_preview");

const validCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

function coordsFromUrl(u) {
  if (!u) return null;
  let s;
  try { s = decodeURIComponent(decodeURIComponent(String(u))); } catch { s = String(u); }
  const pick = (a, b) => (validCoord(+a, +b) ? [+a, +b] : null);
  let m = s.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (m && pick(m[1], m[2])) return pick(m[1], m[2]);
  m = s.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/);
  if (m && pick(m[1], m[2])) return pick(m[1], m[2]);
  m = s.match(/[?&](?:ll|q|query|coordinate|sll|center|destination|daddr)=(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (m && pick(m[1], m[2])) return pick(m[1], m[2]);
  return null;
}

function isMapsUrl(u) {
  try {
    const h = new URL(u).hostname;
    return /(^|\.)google\.[a-z.]+$/.test(h) && /\/maps/.test(new URL(u).pathname) || /^maps\.app\.goo\.gl$|^goo\.gl$|^maps\.google\.|^maps\.apple\.com$/.test(h);
  } catch {
    return false;
  }
}

function nameFromMapsUrl(u) {
  // Le nom est lu encodé (pour garder « & »), puis décodé ; les liens « continue= » sont décodés une fois
  const raw = String(u);
  let once = raw;
  try { once = decodeURIComponent(raw); } catch { /* adresse illisible */ }
  const m = raw.match(/\/maps\/place\/([^/@?&]+)/) || once.match(/\/maps\/place\/([^/@?&]+)/);
  if (m) {
    let name = m[1].replace(/\+/g, " ");
    try { name = decodeURIComponent(name); } catch { /* garder tel quel */ }
    return name.replace(/\+/g, " ").replace(/\s+/g, " ").trim().slice(0, 140) || null;
  }
  try {
    const q = new URL(u).searchParams.get("q") || new URL(u).searchParams.get("name");
    if (q && !/^-?\d/.test(q)) return q.trim().slice(0, 140);
  } catch { /* adresse illisible */ }
  return null;
}

async function geocode(query) {
  const q = String(query || "").replace(/\s+/g, " ").trim();
  if (q.length < 2) return null;
  try {
    const r = await timedFetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q.slice(0, 200))}`, {
      headers: { "User-Agent": "Glane/1.0 (https://getglane.vercel.app)", "Accept-Language": "en" },
    }, 5000);
    if (!r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) return null;
    const lat = +j[0].lat, lng = +j[0].lon;
    return validCoord(lat, lng) ? [lat, lng] : null;
  } catch {
    return null;
  }
}

// Trouve la meilleure position : lien de carte, puis « nom, quartier », puis le quartier seul (approximatif)
async function locate({ urls = [], name, place }) {
  for (const u of urls) {
    const c = coordsFromUrl(u);
    if (c) return { lat: c[0], lng: c[1], geo_approx: false };
  }
  if (name && place) {
    const c = await geocode(`${name}, ${place}`);
    if (c) return { lat: c[0], lng: c[1], geo_approx: false };
  }
  if (place) {
    const c = await geocode(place);
    if (c) return { lat: c[0], lng: c[1], geo_approx: true };
  }
  if (name && !place) {
    const c = await geocode(name);
    if (c) return { lat: c[0], lng: c[1], geo_approx: false };
  }
  return null;
}

const TAG_SETS = ["muscles", "places"];
function cleanTags(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const t of v) {
    const s = String(t || "").replace(/\s+/g, " ").trim().slice(0, 24);
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= 10) break;
  }
  return out;
}
const cleanPlace = (v) => (typeof v === "string" && v.replace(/\s+/g, " ").trim() ? v.replace(/\s+/g, " ").trim().slice(0, 60) : null);

module.exports = { coordsFromUrl, isMapsUrl, nameFromMapsUrl, geocode, locate, cleanTags, cleanPlace, TAG_SETS, validCoord };

});

// ===== _webpush =====
__def("_webpush", (module, exports, require) => {
// Envoi de notifications Web Push sans bibliothèque externe
// Chiffrement RFC 8291 (aes128gcm) et authentification VAPID RFC 8292
const crypto = require("crypto");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");

// Services de notification autorisés (évite d'envoyer des requêtes vers n'importe quelle adresse)
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.googleapis\.com$/, /push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
function allowedEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

function generateVapidKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function vapidJwt(audience, subject, keys, now = Date.now()) {
  const pub = unb64u(keys.publicKey);
  const jwk = { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), { key: crypto.createPrivateKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64u(sig)}`;
}

// Chiffre le contenu pour un abonnement (clés p256dh et auth fournies par le navigateur)
function encrypt(plaintext, p256dh, authSecret, opts = {}) {
  const uaPublic = unb64u(p256dh);
  const auth = unb64u(authSecret);
  const ecdh = crypto.createECDH("prime256v1");
  if (opts.asPrivate) ecdh.setPrivateKey(unb64u(opts.asPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = opts.salt ? unb64u(opts.salt) : crypto.randomBytes(16);
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

async function sendPush(sub, payload, keys, subject) {
  if (!allowedEndpoint(sub.endpoint)) return { status: 400 };
  const body = encrypt(JSON.stringify(payload), sub.p256dh, sub.auth);
  const jwt = vapidJwt(new URL(sub.endpoint).origin, subject, keys);
  try {
    const r = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        TTL: "86400",
        Urgency: "normal",
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
      },
      body,
    });
    return { status: r.status };
  } catch {
    return { status: 0 };
  }
}

module.exports = { generateVapidKeys, vapidJwt, encrypt, sendPush, allowedEndpoint };

});

// ===== auth =====
__def("auth", (module, exports, require) => {
// /api?route=auth : créer un compte, se connecter, garder la session, gérer son compte
const { db, authFetch, deleteImages, configured, requireUser, readBody, newKey, DEFAULT_BOARDS } = require("./_lib");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toSession(d) {
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
    email: (d.user && d.user.email) || null,
  };
}

const passwordLogin = (email, password) => authFetch("token?grant_type=password", { body: { email, password } });

// Première connexion : profil + clé de partage + tableaux par défaut
async function setupAccount(uid) {
  const existing = await db(`profiles?user_id=eq.${uid}&select=user_id`);
  if (existing.length) return;
  const anyProfile = await db("profiles?select=user_id&limit=1");
  await db("profiles", { method: "POST", body: { user_id: uid, share_key: newKey() } });

  if (!anyProfile.length) {
    // Tout premier compte : il récupère les contenus créés avant le passage au multi-utilisateur
    const orphanBoards = await db("boards?user_id=is.null&select=id&limit=1");
    const orphanItems = await db("items?user_id=is.null&select=id&limit=1");
    if (orphanBoards.length || orphanItems.length) {
      await db("boards?user_id=is.null", { method: "PATCH", body: { user_id: uid } });
      await db("items?user_id=is.null", { method: "PATCH", body: { user_id: uid } });
      return;
    }
  }
  const mine = await db(`boards?user_id=eq.${uid}&select=id&limit=1`);
  if (!mine.length) {
    await db("boards", { method: "POST", body: DEFAULT_BOARDS.map((b, i) => ({ ...b, position: i, user_id: uid })) });
  }
}

module.exports = async (req, res) => {
  if (!configured(res)) return;
  try {
    // Réglage public : l'inscription demande-t-elle un code d'invitation ?
    if (req.method === "GET" && req.query && req.query.config) {
      return res.json({ inviteRequired: !!process.env.GLANE_CODE });
    }
    if (req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const [p] = await db(`profiles?user_id=eq.${user.id}&select=share_key,display_name,profile_token`);
      return res.json({
        email: user.email,
        share_key: p ? p.share_key : null,
        display_name: p ? p.display_name : null,
        profile_token: p ? p.profile_token : null,
      });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const b = readBody(req);
    const email = String(b.email || "").trim().toLowerCase();
    const password = String(b.password || "");

    if (b.action === "signup") {
      // Sans variable GLANE_CODE sur Vercel, l'inscription est ouverte à tous
      if (process.env.GLANE_CODE && String(b.invite || "").trim() !== process.env.GLANE_CODE) {
        return res.status(403).json({ error: "This invite code isn't valid." });
      }
      if (!EMAIL.test(email)) return res.status(400).json({ error: "Enter a valid email." });
      if (password.length < 8) return res.status(400).json({ error: "Use at least 8 characters for your password." });
      const created = await authFetch("admin/users", { body: { email, password, email_confirm: true } });
      if (!created.ok) {
        const msg = String(created.data.msg || created.data.message || created.data.error_description || created.data.error || "");
        if (created.status === 422 || /already|exists|registered/i.test(msg)) {
          return res.status(409).json({ error: "An account already exists with this email. Sign in instead." });
        }
        return res.status(502).json({ error: `Couldn't create the account (${created.status}${msg ? ": " + msg : ""}).` });
      }
      const s = await passwordLogin(email, password);
      if (!s.ok) return res.status(502).json({ error: "Account created, but signing in failed. Try signing in." });
      await setupAccount(s.data.user.id);
      return res.json({ session: toSession(s.data) });
    }

    if (b.action === "login") {
      if (!EMAIL.test(email) || !password) return res.status(400).json({ error: "Enter your email and password." });
      const s = await passwordLogin(email, password);
      if (!s.ok) {
        return res.status(400).json({ error: s.status === 429 ? "Too many attempts. Wait a few minutes." : "Wrong email or password." });
      }
      await setupAccount(s.data.user.id);
      return res.json({ session: toSession(s.data) });
    }

    if (b.action === "refresh") {
      const s = await authFetch("token?grant_type=refresh_token", { body: { refresh_token: String(b.refresh_token || "") } });
      if (!s.ok) return res.status(401).json({ error: "Session expired" });
      return res.json({ session: toSession(s.data) });
    }

    // Les actions suivantes demandent une vraie session (pas une clé de Raccourci)
    const user = await requireUser(req, res);
    if (!user) return;
    if (user.viaKey) return res.status(403).json({ error: "Not allowed with a share key" });

    if (b.action === "logout") {
      await authFetch("logout", { token: user.token });
      return res.json({ ok: true });
    }

    if (b.action === "profile") {
      const name = String(b.display_name || "").replace(/\s+/g, " ").trim().slice(0, 40) || null;
      await db(`profiles?user_id=eq.${user.id}`, { method: "PATCH", body: { display_name: name } });
      return res.json({ display_name: name });
    }

    if (b.action === "profile-share") {
      const [cur] = await db(`profiles?user_id=eq.${user.id}&select=profile_token`);
      let token = cur ? cur.profile_token : null;
      if (b.on && !token) token = require("crypto").randomBytes(12).toString("base64url");
      if (!b.on) token = null;
      await db(`profiles?user_id=eq.${user.id}`, { method: "PATCH", body: { profile_token: token } });
      return res.json({ profile_token: token });
    }

    if (b.action === "rotate-key") {
      const share_key = newKey();
      await db(`profiles?user_id=eq.${user.id}`, { method: "PATCH", body: { share_key } });
      return res.json({ share_key });
    }

    if (b.action === "delete-account") {
      if (b.confirm !== "DELETE") return res.status(400).json({ error: "Confirmation missing" });
      const items = await db(`items?user_id=eq.${user.id}&select=image_path`);
      await deleteImages(items.map((i) => i.image_path));
      await db(`items?user_id=eq.${user.id}`, { method: "DELETE" });
      await db(`boards?user_id=eq.${user.id}`, { method: "DELETE" });
      await db(`push_subscriptions?user_id=eq.${user.id}`, { method: "DELETE" });
      await db(`notifications?user_id=eq.${user.id}`, { method: "DELETE" });
      await db(`profiles?user_id=eq.${user.id}`, { method: "DELETE" });
      const d = await authFetch(`admin/users/${user.id}`, { method: "DELETE" });
      if (!d.ok) return res.status(502).json({ error: "Your content was deleted, but the account couldn't be removed. Try again." });
      return res.json({ ok: true });
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

});

// ===== boards =====
__def("boards", (module, exports, require) => {
// /api/boards : les tableaux de l'utilisateur connecté
const crypto = require("crypto");
const { db, requireUser, readBody, clip, UUID } = require("./_lib");

const HEX = /^#[0-9a-f]{6}$/i;
const KINDS = ["collection", "events", "todo", "places"];
const TAG_SETS = ["muscles", "places"];
const ICON = /^[a-z]{2,20}$/; // nom d'icône, rangé dans la colonne emoji

module.exports = async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const mine = `user_id=eq.${user.id}`;

    if (req.method === "GET") {
      const boards = await db(`boards?${mine}&select=*&order=position.asc,created_at.asc`);
      if (req.query.format === "lines") {
        // Texte simple pour le Raccourci iPhone : une ligne par tableau
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        return res.send(boards.map((b) => b.name).concat(["Unsorted"]).join("\n"));
      }
      return res.json({ boards });
    }

    if (req.method === "POST") {
      const b = readBody(req);
      const name = clip(b.name, 40);
      if (!name) return res.status(400).json({ error: "Missing name" });
      const last = await db(`boards?${mine}&select=position&order=position.desc&limit=1`);
      const [board] = await db("boards", {
        method: "POST",
        body: {
          user_id: user.id,
          name,
          emoji: ICON.test(b.icon || "") ? b.icon : "bookmark",
          color: HEX.test(b.color || "") ? b.color : "#D9D6CF",
          kind: KINDS.includes(b.kind) ? b.kind : "collection",
          tagset: TAG_SETS.includes(b.tagset) ? b.tagset : b.kind === "places" ? "places" : null,
          position: last.length ? last[0].position + 1 : 0,
        },
      });
      return res.status(201).json({ board });
    }

    const id = String(req.query.id || "");
    if (!UUID.test(id)) return res.status(400).json({ error: "Invalid id" });
    const target = `boards?id=eq.${id}&${mine}`;

    if (req.method === "PATCH") {
      const b = readBody(req);
      const patch = {};
      if (clip(b.name, 40)) patch.name = clip(b.name, 40);
      if (HEX.test(b.color || "")) patch.color = b.color;
      if (KINDS.includes(b.kind)) patch.kind = b.kind;
      if (ICON.test(b.icon || "")) patch.emoji = b.icon;
      if (typeof b.on_profile === "boolean") patch.on_profile = b.on_profile;
      if ("tagset" in b) patch.tagset = TAG_SETS.includes(b.tagset) ? b.tagset : null;
      // Partage par lien : un jeton aléatoire, supprimé quand on arrête de partager
      if (b.share === true) {
        const [cur] = await db(`${target}&select=share_token`);
        if (!cur) return res.status(404).json({ error: "Board not found" });
        if (!cur.share_token) patch.share_token = crypto.randomBytes(12).toString("base64url");
      }
      if (b.share === false) patch.share_token = null;
      const rows = Object.keys(patch).length
        ? await db(target, { method: "PATCH", body: patch })
        : await db(`${target}&select=*`);
      if (!rows.length) return res.status(404).json({ error: "Board not found" });
      return res.json({ board: rows[0] });
    }

    if (req.method === "DELETE") {
      // Les contenus du tableau passent dans « Unsorted » (clé étrangère ON DELETE SET NULL)
      const rows = await db(target, { method: "DELETE" });
      if (!rows.length) return res.status(404).json({ error: "Board not found" });
      return res.json({ ok: true });
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

});

// ===== items =====
__def("items", (module, exports, require) => {
// /api/items : les contenus de l'utilisateur connecté
const crypto = require("crypto");
const { db, uploadImage, deleteImage, requireUser, readBody, clip, norm, validDate, UUID } = require("./_lib");
const { getPreview, downloadImage, BLOCKED } = require("./_preview");
const { locate, isMapsUrl, nameFromMapsUrl, coordsFromUrl, cleanTags, cleanPlace } = require("./_geo");

// Plan de la semaine : 0 = lundi … 6 = dimanche
const weekDay = (v) => (v === null || v === "" || v === undefined ? null : Number.isInteger(+v) && +v >= 0 && +v <= 6 ? +v : null);
const setsReps = (v) => (typeof v === "string" && v.replace(/\s+/g, " ").trim() ? v.replace(/\s+/g, " ").trim().slice(0, 24) : null);

const isMapsLink = (u) => {
  if (!u) return false;
  if (isMapsUrl(u)) return true;
  try { return /google\.[a-z.]+\/maps/.test(decodeURIComponent(u)); } catch { return false; }
};

async function boardInfo(uid, boardId) {
  if (!boardId) return null;
  const rows = await db(`boards?id=eq.${boardId}&user_id=eq.${uid}&select=id,kind,tagset`);
  return rows[0] || null;
}

function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.slice(0, 3).toString() === "GIF") return "image/gif";
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  if (buf.slice(4, 12).toString().includes("ftyphei")) return "image/heic";
  return "image/jpeg";
}

function decodeB64(value) {
  const b64 = typeof value === "string" ? value.replace(/^data:[^,]+,/, "").replace(/\s+/g, "") : "";
  if (!b64) return null;
  const buffer = Buffer.from(b64, "base64");
  return buffer.length >= 100 ? buffer : null;
}

// Un tableau n'est accepté que s'il appartient à l'utilisateur
async function ownBoard(uid, boardId) {
  if (!boardId || !UUID.test(boardId)) return null;
  const rows = await db(`boards?id=eq.${boardId}&user_id=eq.${uid}&select=id`);
  return rows.length ? boardId : null;
}

async function resolveBoard(uid, b) {
  if (b.board_id) return ownBoard(uid, b.board_id);
  const wanted = norm(b.board);
  if (!wanted) return null;
  const boards = await db(`boards?user_id=eq.${uid}&select=id,name,slug`);
  const found = boards.find((x) => norm(x.name) === wanted || (x.slug && norm(x.slug) === wanted));
  return found ? found.id : null;
}

async function storeRemoteImage(imageUrl, pageUrl, name) {
  const img = await downloadImage(imageUrl, pageUrl);
  if (!img) return { image_url: imageUrl, image_path: null };
  const up = await uploadImage(img.buffer, img.contentType, name);
  return { image_url: up.url, image_path: up.path };
}

async function create(req, res, uid) {
  const b = readBody(req);
  const id = crypto.randomUUID();
  const file = `${uid}/${id}`;
  const row = {
    id,
    user_id: uid,
    board_id: await resolveBoard(uid, b),
    title: clip(b.title, 140),
    note: clip(b.note, 1000),
    event_date: validDate(b.event_date),
    remind_on: validDate(b.remind_on),
    place: cleanPlace(b.place),
    week_day: weekDay(b.week_day),
    sets_reps: setsReps(b.sets_reps),
  };
  const tags = cleanTags(b.tags);
  if (tags) row.tags = tags;
  const board = await boardInfo(uid, row.board_id);
  let finalUrl = null;
  const buffer = decodeB64(b.image_base64);
  const text = typeof b.text === "string" ? b.text.trim() : "";
  let url = typeof b.url === "string" ? b.url.trim() : "";

  // Un partage arrive souvent sous la forme « Regarde ça https://… » : on isole le lien
  if (!url && text) {
    const m = text.match(/https?:\/\/[^\s<>"]+/);
    if (m && text.replace(m[0], "").trim().length < 120) url = m[0].replace(/[)\].,;!?»"']+$/, "");
  }

  if (url) {
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Invalid link" });
    row.url = url.slice(0, 2000);
    const hint = b.preview && typeof b.preview === "object" && !b.preview.isImage && (b.preview.image || b.preview.title) ? b.preview : null;
    const p = hint || (await getPreview(url));
    finalUrl = p.finalUrl || null;

    if (p.imageDirect && !buffer) {
      const up = await uploadImage(p.buffer, p.contentType, file);
      Object.assign(row, { type: "image", image_url: up.url, image_path: up.path, site: clip(p.site, 80) });
    } else {
      row.type = "link";
      row.site = clip(p.site, 80);
      row.price = clip(p.price, 40);
      if (isMapsLink(url) || isMapsLink(finalUrl)) {
        // Lien de carte : le nom du lieu est dans l'adresse, la page elle-même n'apprend rien
        row.site = "Maps";
        if (!row.title) row.title = clip(nameFromMapsUrl(finalUrl || "") || nameFromMapsUrl(url) || "", 140);
      } else if (!row.title && p.title && !BLOCKED.test(p.title)) row.title = clip(p.title, 140);
      if (buffer) {
        const up = await uploadImage(buffer, sniff(buffer), file);
        Object.assign(row, { image_url: up.url, image_path: up.path });
      } else if (p.image) {
        Object.assign(row, await storeRemoteImage(p.image, url, file));
      }
    }
  } else if (buffer) {
    const up = await uploadImage(buffer, sniff(buffer), file);
    Object.assign(row, { type: "image", image_url: up.url, image_path: up.path });
  } else if (text) {
    row.type = "text";
    row.text = text.slice(0, 5000);
  } else {
    return res.status(400).json({ error: "Nothing to save" });
  }

  // Un lieu (tableau Places ou lien de carte) reçoit sa position
  if ((board && board.kind === "places") || isMapsLink(url) || isMapsLink(finalUrl)) {
    const name = row.title || (row.text ? row.text.split("\n")[0].slice(0, 120) : null);
    const loc = await locate({ urls: [url, finalUrl].filter(Boolean), name, place: row.place });
    if (loc) Object.assign(row, loc);
  }

  const [saved] = await db("items", { method: "POST", body: row });
  res.status(201).json({ item: saved });
}

async function update(req, res, uid, id) {
  const b = readBody(req);
  const target = `items?id=eq.${id}&user_id=eq.${uid}`;
  const [cur] = await db(`${target}&select=*`);
  if (!cur) return res.status(404).json({ error: "Item not found" });
  const patch = {};

  if ("title" in b) patch.title = clip(b.title, 140);
  if ("note" in b) patch.note = clip(b.note, 1000);
  if ("text" in b && clip(b.text, 5000)) patch.text = clip(b.text, 5000);
  if ("board_id" in b) patch.board_id = await ownBoard(uid, b.board_id);
  if ("event_date" in b) patch.event_date = validDate(b.event_date);
  if (b.opened) patch.opened_at = new Date().toISOString();
  if (b.done === true) patch.done_at = cur.done_at || new Date().toISOString();
  if (b.done === false) patch.done_at = null;
  if (b.archived === true) patch.archived_at = cur.archived_at || new Date().toISOString();
  if (b.archived === false) patch.archived_at = null;
  if ("tags" in b) patch.tags = cleanTags(b.tags) || [];
  if ("place" in b) patch.place = cleanPlace(b.place);
  if ("week_day" in b) patch.week_day = weekDay(b.week_day);
  if ("sets_reps" in b) patch.sets_reps = setsReps(b.sets_reps);
  if ("remind_on" in b) {
    patch.remind_on = validDate(b.remind_on);
    patch.reminded_at = null; // nouvelle date : le rappel repart
  }

  const buffer = decodeB64(b.image_base64);
  if (buffer) {
    const up = await uploadImage(buffer, sniff(buffer), `${uid}/${id}-${Date.now()}`);
    patch.image_url = up.url;
    patch.image_path = up.path;
  }

  // Nouvel essai d'aperçu (utile pour les contenus enregistrés pendant qu'un site bloquait)
  if (b.refresh && cur.url) {
    const p = await getPreview(cur.url);
    const badTitle = !cur.title || BLOCKED.test(cur.title);
    if (badTitle && p.title && !BLOCKED.test(p.title)) patch.title = clip(p.title, 140);
    else if (badTitle && cur.title) patch.title = null;
    if (!cur.site && p.site) patch.site = clip(p.site, 80);
    if (!cur.price && p.price) patch.price = clip(p.price, 40);
    if (!cur.image_url && !buffer && p.image) Object.assign(patch, await storeRemoteImage(p.image, cur.url, `${uid}/${id}-${Date.now()}`));
  }

  // Nouvelle position si le lieu, son nom ou son tableau change (sauf position exacte venue d'un lien de carte)
  const nextBoardId = "board_id" in patch ? patch.board_id : cur.board_id;
  const nextBoard = await boardInfo(uid, nextBoardId);
  const placeChanged = "place" in patch && patch.place !== cur.place;
  const titleChanged = "title" in patch && patch.title !== cur.title;
  const movedIn = "board_id" in patch && patch.board_id !== cur.board_id && cur.lat == null;
  const exactFromUrl = cur.url && coordsFromUrl(cur.url);
  // Seulement quand quelque chose qui change la position a changé (pas à chaque case cochée)
  if (nextBoard && nextBoard.kind === "places" && !exactFromUrl && (placeChanged || titleChanged || movedIn)) {
    const nextPlace = "place" in patch ? patch.place : cur.place;
    const name = ("title" in patch ? patch.title : cur.title) || (cur.text ? cur.text.split("\n")[0].slice(0, 120) : null);
    const loc = await locate({ urls: [], name, place: nextPlace });
    if (loc) Object.assign(patch, loc);
    else if (placeChanged) Object.assign(patch, { lat: null, lng: null, geo_approx: false });
  }

  if (!Object.keys(patch).length) return res.json({ item: cur });
  const [item] = await db(target, { method: "PATCH", body: patch });
  if (patch.image_path && cur.image_path && cur.image_path !== patch.image_path) await deleteImage(cur.image_path);
  return res.json({ item });
}

module.exports = async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === "GET") {
      // ?archived=1 : la section Archive, du plus récemment archivé au plus ancien
      const items = req.query.archived
        ? await db(`items?user_id=eq.${user.id}&archived_at=not.is.null&select=*&order=archived_at.desc&limit=2000`)
        : await db(`items?user_id=eq.${user.id}&archived_at=is.null&select=*&order=created_at.desc&limit=2000`);
      return res.json({ items });
    }
    if (req.method === "POST") return await create(req, res, user.id);

    const id = String(req.query.id || "");
    if (!UUID.test(id)) return res.status(400).json({ error: "Invalid id" });

    if (req.method === "PATCH") return await update(req, res, user.id, id);

    if (req.method === "DELETE") {
      const rows = await db(`items?id=eq.${id}&user_id=eq.${user.id}`, { method: "DELETE" });
      if (!rows.length) return res.status(404).json({ error: "Item not found" });
      await deleteImage(rows[0].image_path);
      return res.json({ ok: true });
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

});

// ===== preview =====
__def("preview", (module, exports, require) => {
// GET /api/preview?url=... : aperçu d'un lien avant de le ranger
const { requireUser } = require("./_lib");
const { getPreview } = require("./_preview");

module.exports = async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const url = String((req.query && req.query.url) || "");
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Invalid link" });
    const p = await getPreview(url);
    res.json({ title: p.title || null, image: p.image || null, site: p.site || null, price: p.price || null, isImage: !!p.imageDirect, finalUrl: p.finalUrl || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

});

// ===== push =====
__def("push", (module, exports, require) => {
// /api?route=push : abonnement aux notifications, test, retour « Keep / Let go »
// /api/cron : la notification du matin (lancée une fois par jour par Vercel)
const crypto = require("crypto");
const { db, requireUser, configured, readBody, UUID } = require("./_lib");
const { generateVapidKeys, sendPush, allowedEndpoint } = require("./_webpush");

const TZ = "Asia/Dubai";
const MIN_ITEMS = 5;
const DAY = 86400000;
const now = () => (process.env.GLANE_FAKE_NOW ? new Date(process.env.GLANE_FAKE_NOW) : new Date());

// ---------- Clés de notification : créées une fois, gardées dans la base ----------
async function vapidKeys() {
  const rows = await db("push_config?id=eq.1&select=public_key,private_key");
  if (rows.length) return { publicKey: rows[0].public_key, privateKey: rows[0].private_key };
  const k = generateVapidKeys();
  try {
    await db("push_config", { method: "POST", body: { id: 1, public_key: k.publicKey, private_key: k.privateKey } });
    return k;
  } catch {
    const again = await db("push_config?id=eq.1&select=public_key,private_key");
    return { publicKey: again[0].public_key, privateKey: again[0].private_key };
  }
}

// ---------- Dates à l'heure de Dubaï ----------
function localDay(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function localWeekday(d) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d);
}
function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function ago(created, ref) {
  const days = Math.floor((ref - new Date(created)) / DAY);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return "in " + new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: TZ }).format(new Date(created));
}
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s || "");
const BLOCKED = /^\s*(access denied|just a moment|attention required|403 forbidden|forbidden|are you a robot)\b/i;
const label = (i) => {
  const t = i.title && !BLOCKED.test(i.title) ? i.title : "";
  if (t) return t;
  if (i.type === "text" && i.text) return i.text.split("\n")[0];
  if (i.site) return `something from ${i.site}`;
  try { return `something from ${new URL(i.url).hostname.replace(/^www\./, "")}`; } catch { return "something you saved"; }
};

// ---------- Le choix du jour ----------
// Familles de contenus, reconnues au tableau (identifiant, icône ou nom)
const FAMILY_RULES = {
  quote: { slugs: ["quotes"], icons: ["quote"], name: /quote|citation|thought|pens[ée]e/i },
  reading: { slugs: ["reading"], icons: ["book"], name: /read|book|livre|article|essay|lecture/i },
  culture: { slugs: [], icons: ["film", "music", "palette", "camera"], name: /film|cin[ée]ma|movie|music|musique|art|expo|exhibit|museum|mus[ée]e|culture|podcast|th[ée][aâ]tre|theat/i },
  mind: { slugs: ["spiritual", "fitness"], icons: ["leaf", "sparkles", "dumbbell", "heart"], name: /mind|spirit|medit|well|yoga|fitness|sport|soul/i },
  table: { slugs: ["food"], icons: ["utensils", "coffee"], name: /food|recipe|recette|cook|cuisine|restaurant/i },
  places: { slugs: ["spots"], icons: ["plane", "globe", "home", "pin"], name: /travel|voyage|place|trip|city|lieu|spot/i },
};

// Le tableau décide en priorité ; une note sans tableau reconnu est traitée comme une pensée
function familyOf(item, board) {
  if (board) {
    for (const [fam, r] of Object.entries(FAMILY_RULES)) {
      if (r.slugs.includes(board.slug) || r.icons.includes(board.emoji) || r.name.test(board.name || "")) return fam;
    }
  }
  return item.type === "text" ? "quote" : "other";
}

// Thème de chaque jour : lun une pensée, mar lecture, mer culture, jeu esprit et corps,
// ven table et lieux pour le week-end, sam « depuis tes archives », dim récap de la semaine
const THEMES = { Mon: ["quote"], Tue: ["reading"], Wed: ["culture"], Thu: ["mind"], Fri: ["table", "places", "culture"], Sat: [], Sun: [] };

const MESSAGES = {
  quote: (i) => ({ title: "A thought for today", body: `“${clip(i.text || label(i), 150)}”` }),
  reading: (i, when) => ({ title: "From your reading list", body: `${clip(label(i), 80)}, saved ${when}.` }),
  culture: (i, when) => ({ title: "Something to come back to", body: `${clip(label(i), 80)}, saved ${when}.` }),
  mind: (i, when) => ({ title: "For your mind today", body: `${clip(label(i), 80)}, saved ${when}.` }),
  table: (i, when, weekday) => ({ title: weekday === "Fri" ? "For the weekend" : "An idea for today", body: `${clip(label(i), 80)}, saved ${when}.` }),
  places: (i, when, weekday) => ({ title: weekday === "Fri" ? "For the weekend" : "A place you kept", body: `${clip(label(i), 80)}, saved ${when}.` }),
};

function pickDaily(allItems, boards, ref) {
  const byId = Object.fromEntries(boards.map((b) => [b.id, b]));
  // Les tâches (tableaux To-do) et ce qui est coché ne sont pas de l'inspiration
  const items = allItems.filter((i) => !i.done_at && (byId[i.board_id] || {}).kind !== "todo");
  const today = localDay(ref);
  const tomorrow = addDays(today, 1);

  // 1. Un événement aujourd'hui ou demain passe toujours en premier
  const events = items.filter((i) => i.event_date && (i.event_date === today || i.event_date === tomorrow));
  events.sort((a, b) => a.event_date.localeCompare(b.event_date));
  const ev = events.find((i) => !i.last_surfaced_at || localDay(new Date(i.last_surfaced_at)) !== today);
  if (ev) {
    const when = ev.event_date === today ? "Today" : "Tomorrow";
    return { kind: "event", item: ev, title: `${when}: ${clip(label(ev), 60)}`, body: `You saved this ${ago(ev.created_at, ref)}.` };
  }

  if (items.length < MIN_ITEMS) return null;
  const weekday = localWeekday(ref);

  // 2. Le dimanche : un moment pour regarder sa semaine
  if (weekday === "Sun") {
    const week = items.filter((i) => ref - new Date(i.created_at) < 7 * DAY);
    if (week.length) {
      const unopened = week.filter((i) => !i.opened_at).length;
      return {
        kind: "recap",
        item: null,
        title: `Your week in ${week.length} thing${week.length > 1 ? "s" : ""}`,
        body: unopened ? `${unopened} still waiting for you. Take a quiet moment with them.` : "Take a quiet moment with them.",
      };
    }
  }

  // 3. Sinon, un élément gardé qui revient
  const surfacedOk = (i, days) => !i.last_surfaced_at || ref - new Date(i.last_surfaced_at) >= days * DAY;
  const oldEnough = (i, days) => ref - new Date(i.created_at) >= days * DAY;
  const pool = items.filter((i) => !(i.event_date && i.event_date < today));
  let candidates = pool.filter((i) => oldEnough(i, 7) && surfacedOk(i, 30));
  if (!candidates.length) candidates = pool.filter((i) => oldEnough(i, 2) && surfacedOk(i, 30));
  if (!candidates.length) candidates = pool.filter((i) => surfacedOk(i, 7));
  if (!candidates.length) candidates = pool.slice().sort((a, b) => new Date(a.last_surfaced_at || 0) - new Date(b.last_surfaced_at || 0)).slice(0, 1);
  if (!candidates.length) return null;

  // Les familles du thème sont essayées dans l'ordre ; sinon (et le samedi), tout le monde
  const theme = THEMES[weekday] || [];
  let list = [];
  for (const fam of theme) {
    list = candidates.filter((i) => familyOf(i, byId[i.board_id]) === fam);
    if (list.length) break;
  }
  if (!list.length) list = candidates;
  list.sort((a, b) => (!!a.opened_at - !!b.opened_at) || (!!a.last_surfaced_at - !!b.last_surfaced_at) || (new Date(a.created_at) - new Date(b.created_at)));
  const item = list[0];
  const board = byId[item.board_id];
  const when = ago(item.created_at, ref);
  const fam = familyOf(item, board);
  if (MESSAGES[fam]) return { kind: fam, item, ...MESSAGES[fam](item, when, weekday) };
  return {
    kind: "archive",
    item,
    title: weekday === "Sat" ? "From your archive" : board ? `From your ${board.name} board` : "Something you kept",
    body: `${clip(label(item), 80)}, saved ${when}.`,
  };
}

// Rappels arrivés à échéance (y compris un jour manqué), pas encore envoyés
function dueReminders(items, ref) {
  const today = localDay(ref);
  return items
    .filter((i) => i.remind_on && i.remind_on <= today && !i.reminded_at && !i.done_at)
    .sort((a, b) => a.remind_on.localeCompare(b.remind_on));
}

function reminderPick(due) {
  if (due.length === 1) {
    return { kind: "reminder", item: due[0], reminders: due, title: `Reminder: ${clip(label(due[0]), 60)}`, body: "You asked to be reminded today." };
  }
  const names = due.slice(0, 3).map((i) => clip(label(i), 40)).join(" · ");
  return {
    kind: "reminder",
    item: null,
    reminders: due,
    title: `${due.length} reminders for today`,
    body: due.length > 3 ? `${names} and ${due.length - 3} more` : names,
  };
}

async function loadUserData(uid) {
  const [items, boards] = await Promise.all([
    db(`items?user_id=eq.${uid}&archived_at=is.null&select=id,type,title,text,site,price,url,board_id,event_date,created_at,last_surfaced_at,opened_at,remind_on,reminded_at,done_at&limit=2000`),
    db(`boards?user_id=eq.${uid}&select=id,name,slug,kind,emoji`),
  ]);
  return { items, boards };
}

async function deliver(uid, pick, keys, subject, { test = false } = {}) {
  const subs = await db(`push_subscriptions?user_id=eq.${uid}&select=endpoint,p256dh,auth`);
  if (!subs.length) return { sent: 0 };
  const id = crypto.randomUUID();
  if (!test) {
    await db("notifications", { method: "POST", body: { id, user_id: uid, item_id: pick.item ? pick.item.id : null, kind: pick.kind, title: pick.title, body: pick.body } });
    if (pick.item) await db(`items?id=eq.${pick.item.id}&user_id=eq.${uid}`, { method: "PATCH", body: { last_surfaced_at: now().toISOString() } });
    for (const r of pick.reminders || []) {
      await db(`items?id=eq.${r.id}&user_id=eq.${uid}`, { method: "PATCH", body: { reminded_at: now().toISOString() } });
    }
  }
  const url = pick.item ? `/?n=${test ? "test" : id}&item=${pick.item.id}` : `/?n=${test ? "test" : id}`;
  const payload = { title: pick.title, body: pick.body, url, tag: test ? "glane-test" : "glane-daily" };
  let sent = 0;
  for (const s of subs) {
    const r = await sendPush(s, payload, keys, subject);
    if (r.status >= 200 && r.status < 300) sent++;
    // Abonnement expiré ou supprimé côté téléphone : on l'oublie
    if (r.status === 404 || r.status === 410) await db(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE" });
  }
  if (!test) await db(`notifications?id=eq.${id}`, { method: "PATCH", body: { delivered: sent } });
  return { sent };
}

const subjectFor = (req) => `https://${String(req.headers.host || "glane.vercel.app").replace(/[^a-z0-9.:-]/gi, "")}`;

// ---------- Tâche du matin ----------
async function runDaily(req, res) {
  if (!configured(res)) return;
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "Unauthorized" });
  const ref = now();
  const today = localDay(ref);
  const keys = await vapidKeys();
  const subject = subjectFor(req);
  const subs = await db("push_subscriptions?select=user_id");
  const users = [...new Set(subs.map((s) => s.user_id))];
  const summary = { users: users.length, sent: 0, skipped: 0, already: 0 };

  const queue = users.slice();
  async function worker() {
    while (queue.length) {
      const uid = queue.shift();
      try {
        const last = await db(`notifications?user_id=eq.${uid}&select=sent_at&order=sent_at.desc&limit=1`);
        if (last.length && localDay(new Date(last[0].sent_at)) === today) { summary.already++; continue; }
        const { items, boards } = await loadUserData(uid);
        const due = dueReminders(items, ref);
        const pick = due.length ? reminderPick(due) : pickDaily(items, boards, ref);
        if (!pick) { summary.skipped++; continue; }
        const r = await deliver(uid, pick, keys, subject);
        summary.sent += r.sent;
      } catch (e) {
        console.error("daily push failed for", uid, e.message);
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  res.json(summary);
}

// ---------- Actions de l'app ----------
async function handle(req, res) {
  if (!configured(res)) return;
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.viaKey) return res.status(403).json({ error: "Not allowed with a share key" });

  if (req.method === "GET") {
    const keys = await vapidKeys();
    const subs = await db(`push_subscriptions?user_id=eq.${user.id}&select=endpoint`);
    return res.json({ publicKey: keys.publicKey, devices: subs.length });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const b = readBody(req);

  if (b.action === "subscribe") {
    const s = b.subscription || {};
    const endpoint = String(s.endpoint || "");
    const p256dh = String((s.keys && s.keys.p256dh) || "");
    const auth = String((s.keys && s.keys.auth) || "");
    if (!allowedEndpoint(endpoint) || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) {
      return res.status(400).json({ error: "This device can't receive notifications." });
    }
    await db(`push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: "DELETE" });
    await db("push_subscriptions", { method: "POST", body: { endpoint, user_id: user.id, p256dh, auth } });
    return res.json({ ok: true });
  }

  if (b.action === "unsubscribe") {
    await db(`push_subscriptions?endpoint=eq.${encodeURIComponent(String(b.endpoint || ""))}&user_id=eq.${user.id}`, { method: "DELETE" });
    return res.json({ ok: true });
  }

  if (b.action === "test") {
    const { items, boards } = await loadUserData(user.id);
    const due = dueReminders(items, now());
    const pick = (due.length ? reminderPick(due) : pickDaily(items, boards, now())) || {
      kind: "test", item: null, title: "Notifications are on",
      body: items.length < MIN_ITEMS ? `Save ${MIN_ITEMS - items.length} more thing${MIN_ITEMS - items.length > 1 ? "s" : ""} to get a daily pick.` : "See you tomorrow morning.",
    };
    const r = await deliver(user.id, pick, await vapidKeys(), subjectFor(req), { test: true });
    return res.json({ sent: r.sent, title: pick.title, body: pick.body });
  }

  if (b.action === "feedback") {
    const value = ["open", "keep", "let_go", "done"].includes(b.value) ? b.value : null;
    if (!value) return res.status(400).json({ error: "Unknown answer" });
    if (UUID.test(String(b.n || ""))) {
      await db(`notifications?id=eq.${b.n}&user_id=eq.${user.id}`, { method: "PATCH", body: value === "open" ? { opened_at: now().toISOString() } : { action: value } });
    }
    if (UUID.test(String(b.item || ""))) {
      const target = `items?id=eq.${b.item}&user_id=eq.${user.id}`;
      if (value === "let_go") await db(target, { method: "PATCH", body: { archived_at: now().toISOString() } });
      if (value === "open") await db(target, { method: "PATCH", body: { opened_at: now().toISOString() } });
      if (value === "done") await db(target, { method: "PATCH", body: { remind_on: null, reminded_at: null } });
    }
    return res.json({ ok: true });
  }

  res.status(400).json({ error: "Unknown action" });
}

module.exports = async (req, res) => {
  try {
    if (req.query && req.query.route === "cron") return await runDaily(req, res);
    return await handle(req, res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
module.exports.pickDaily = pickDaily;
module.exports.familyOf = familyOf;
module.exports.dueReminders = dueReminders;
module.exports.reminderPick = reminderPick;

});

// ===== public =====
__def("public", (module, exports, require) => {
// /api?route=public&t=... : un tableau partagé par lien, lisible sans compte
// Avec &html=1 : la page de l'app, avec l'aperçu (titre, image) pour WhatsApp, iMessage, etc.
const { db, configured, UUID } = require("./_lib");
const { BLOCKED } = require("./_preview");

const TOKEN = /^[A-Za-z0-9_-]{16,40}$/;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function load(token) {
  const boards = await db(`boards?share_token=eq.${token}&select=id,name,emoji,color,kind,slug,tagset`);
  if (!boards.length) return null;
  const board = boards[0];
  // Jamais les notes perso, ni ce qui a été mis de côté
  const items = await db(`items?board_id=eq.${board.id}&archived_at=is.null&select=${ITEM_FIELDS}&order=created_at.desc&limit=500`);
  for (const i of items) if (i.title && BLOCKED.test(i.title)) i.title = null;
  return { board, items };
}

const ITEM_FIELDS = "id,type,title,text,url,site,image_url,event_date,created_at,board_id,done_at,tags,place";

async function loadProfile(token) {
  const profs = await db(`profiles?profile_token=eq.${token}&select=user_id,display_name`);
  if (!profs.length) return null;
  const owner = profs[0];
  const boards = await db(`boards?user_id=eq.${owner.user_id}&on_profile=eq.true&select=id,name,emoji,color,kind,slug,tagset,position&order=position.asc`);
  const list = [];
  if (boards.length) {
    const items = await db(`items?board_id=in.(${boards.map((b) => b.id).join(",")})&archived_at=is.null&select=board_id,type,text,image_url&order=created_at.desc&limit=3000`);
    for (const b of boards) {
      const its = items.filter((i) => i.board_id === b.id);
      const quote = its.find((i) => i.type === "text" && i.text);
      const { position, ...pub } = b;
      list.push({ ...pub, count: its.length, covers: its.filter((i) => i.image_url).slice(0, 4).map((i) => i.image_url), quote: quote ? quote.text.slice(0, 140) : null });
    }
  }
  return { owner: owner.user_id, profile: { name: owner.display_name || "Someone", boards: list } };
}

async function loadProfileBoard(token, boardId) {
  if (!UUID.test(boardId)) return null;
  const profs = await db(`profiles?profile_token=eq.${token}&select=user_id`);
  if (!profs.length) return null;
  const boards = await db(`boards?id=eq.${boardId}&user_id=eq.${profs[0].user_id}&on_profile=eq.true&select=id,name,emoji,color,kind,slug,tagset`);
  if (!boards.length) return null;
  const items = await db(`items?board_id=eq.${boardId}&archived_at=is.null&select=${ITEM_FIELDS}&order=created_at.desc&limit=500`);
  for (const i of items) if (i.title && BLOCKED.test(i.title)) i.title = null;
  return { board: boards[0], items };
}

async function page(req, res, data, token) {
  const host = String(req.headers.host || "").replace(/[^a-z0-9.:-]/gi, "");
  const proto = req.headers["x-forwarded-proto"] || (/^(localhost|127\.)/.test(host) ? "http" : "https");
  let html;
  try {
    const r = await fetch(`${proto}://${host}/index.html`);
    if (!r.ok) throw new Error("index " + r.status);
    html = await r.text();
  } catch {
    // Sans la page, on renvoie vers la version simple du lien
    res.setHeader("Location", `/?${req.query.p ? "p" : "s"}=${encodeURIComponent(token)}`);
    return res.status(302).send("");
  }
  const isProfile = !!(data && data.profile) || req.query.p;
  const path = isProfile ? `/p/${token}` : `/s/${token}`;
  let title = "Glane";
  let desc = isProfile ? "This profile isn't shared anymore." : "This board isn't shared anymore.";
  let coverUrl = null;
  if (data && data.profile) {
    const n = data.profile.boards.length;
    title = `${data.profile.name} · Glane`;
    desc = `${n} board${n === 1 ? "" : "s"} kept on Glane.`;
    const withCover = data.profile.boards.find((b) => b.covers.length);
    coverUrl = withCover ? withCover.covers[0] : null;
  } else if (data) {
    const count = data.items.length;
    title = `${data.board.name} · Glane`;
    desc = `${count} thing${count === 1 ? "" : "s"} kept on Glane.`;
    const c = data.items.find((i) => i.image_url);
    coverUrl = c ? c.image_url : null;
  }
  const cover = coverUrl ? { image_url: coverUrl } : null;
  const meta = [
    `<meta name="robots" content="noindex, nofollow">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Glane">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(`${proto}://${host}${path}`)}">`,
    cover ? `<meta property="og:image" content="${esc(cover.image_url)}">` : `<meta property="og:image" content="${esc(`${proto}://${host}/icon-512.png`)}">`,
    `<meta name="twitter:card" content="${cover ? "summary_large_image" : "summary"}">`,
  ].join("\n");
  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(desc)}">\n${meta}`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  return res.status(data ? 200 : 404).send(html);
}

module.exports = async (req, res) => {
  if (!configured(res)) return;
  try {
    if (req.query.p !== undefined) {
      const token = String(req.query.p || "");
      // La page HTML passe en premier, même si l'adresse contient ?b= (tableau ouvert depuis le profil)
      if (req.query.b && !req.query.html) {
        const board = TOKEN.test(token) ? await loadProfileBoard(token, String(req.query.b)) : null;
        if (!board) return res.status(404).json({ error: "This board isn't on the profile anymore." });
        res.setHeader("Cache-Control", "public, s-maxage=30");
        return res.json(board);
      }
      const prof = TOKEN.test(token) ? await loadProfile(token) : null;
      if (req.query.html) return await page(req, res, prof, token);
      if (!prof) return res.status(404).json({ error: "This profile isn't shared anymore." });
      res.setHeader("Cache-Control", "public, s-maxage=30");
      return res.json({ profile: prof.profile });
    }
    const token = String((req.query && req.query.t) || "");
    const data = TOKEN.test(token) ? await load(token) : null;
    if (req.query.html) return await page(req, res, data, token);
    if (!data) return res.status(404).json({ error: "This board isn't shared anymore." });
    res.setHeader("Cache-Control", "public, s-maxage=30");
    return res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

});

// ===== Routing: /api/boards, /api/items, /api/preview, /api/cron, /api?route=auth|push =====
module.exports = async (req, res) => {
  const route = String((req.query && req.query.route) || "").replace(/^\/+|\/+$/g, "");
  const handler = { auth: __mods.auth, boards: __mods.boards, items: __mods.items, preview: __mods.preview, push: __mods.push, cron: __mods.push, public: __mods.public }[route];
  if (!handler) return res.status(404).json({ error: "Unknown route" });
  return handler(req, res);
};
