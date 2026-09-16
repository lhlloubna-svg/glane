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
