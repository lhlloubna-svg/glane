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
