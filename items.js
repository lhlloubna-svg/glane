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
