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
