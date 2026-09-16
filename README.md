# Glane, MVP gratuit

Ton moodboard perso sur téléphone :
- tu partages un lien (une bague, une recette, un article), une photo ou une citation ;
- tu choisis le tableau en un tap ;
- l'app récupère l'image et le prix du produit quand le site le permet.

**Coût : 0 €.** GitHub, Vercel (formule Hobby) et Supabase (formule Free).

Compte environ 30 minutes la première fois.

---

## 1. Supabase : la base de données (10 min)

1. Crée un compte sur supabase.com, puis un nouveau projet (région proche de Dubaï, par exemple Mumbai ou Francfort). Garde le mot de passe de la base quelque part.
2. Dans le menu de gauche, ouvre **SQL Editor**, colle tout le contenu du fichier `supabase.sql`, puis clique sur **Run**. Tes 8 tableaux et l'espace de stockage des images sont créés.
3. Récupère deux informations :
   - **l'URL du projet**, de la forme `https://xxxx.supabase.co` (bouton **Connect** ou **Project Settings**) ;
   - **une clé secrète**, dans **Project Settings > API Keys**. Prends une clé `sb_secret_…`, ou la clé `service_role` si ton projet affiche les anciennes clés.

⚠️ La clé secrète donne tous les droits sur ta base. Elle va uniquement dans Vercel, jamais dans le code ni dans un message.

## 2. GitHub : le code (3 min)

1. Crée un nouveau dépôt **privé**, par exemple `glane`.
2. Clique sur **uploading an existing file** et glisse tout le contenu du dossier : `index.html`, `manifest.json`, `sw.js`, `vercel.json`, `supabase.sql`, `README.md`, et les dossiers `api` et `icons`.
3. Valide avec **Commit changes**.

## 3. Vercel : la mise en ligne (5 min)

1. Sur vercel.com, fais **Add New > Project**, puis importe le dépôt `glane`.
2. Dans Framework Preset, laisse **Other**.
3. Ouvre **Environment Variables** et ajoute ces trois variables :

| Nom | Valeur |
|---|---|
| `SUPABASE_URL` | l'URL du projet Supabase |
| `SUPABASE_SECRET_KEY` | la clé secrète Supabase |
| `GLANE_CODE` | un code d'accès que tu inventes (au moins 8 caractères) |

4. Clique sur **Deploy**. Tu obtiens une adresse du type `https://glane-xxx.vercel.app`.
5. Ouvre-la et entre ton code : tes tableaux s'affichent.

## 4. Installer l'app sur ton téléphone

**iPhone :**
1. Ouvre l'adresse dans **Safari**.
2. Touche Partager, puis **Sur l'écran d'accueil**.
3. Ouvre Glane depuis l'icône et entre ton code une fois.

**Android :**
1. Ouvre l'adresse dans **Chrome**.
2. Ouvre le menu ⋮, puis **Installer l'application** (ou **Ajouter à l'écran d'accueil**).
3. Ouvre Glane et entre ton code une fois.

C'est tout pour Android : **Glane apparaît directement dans le menu Partager**, depuis n'importe quelle app.

## 5. iPhone : les deux Raccourcis de partage

Sur iPhone, une web app ne peut pas apparaître seule dans le menu Partager. Les Raccourcis font le lien. Dans les étapes ci-dessous :
- remplace `TON-APP` par ton adresse Vercel ;
- remplace `TONCODE` par ton code d'accès.

### Raccourci « Glane » (liens et textes)

1. Ouvre l'app **Raccourcis**, touche **+** et nomme le raccourci « Glane ».
2. Touche l'icône ⓘ, active **Afficher dans la feuille de partage**, puis choisis les types **URL** et **Texte**.
3. Ajoute les actions suivantes, dans cet ordre :
   1. **Obtenir le contenu de l'URL**, avec l'URL :
      `https://TON-APP.vercel.app/api/boards?format=lines&code=TONCODE`
   2. **Séparer le texte**, par **Nouvelles lignes**.
   3. **Choisir dans la liste**, avec l'invite « Où tu le ranges ? ».
   4. **Obtenir le contenu de l'URL**, avec l'URL `https://TON-APP.vercel.app/api/items`. Touche **Afficher plus** et règle :
      - **Méthode** : `POST` ;
      - **En-têtes** : une clé `x-glane-code`, valeur `TONCODE` ;
      - **Corps de la requête** : `JSON`, avec deux champs texte :
        - `text` = la variable **Entrée du raccourci** ;
        - `board` = la variable **Élément choisi**.
   5. **Afficher la notification**, avec le texte « Rangé dans Glane ».

**Pour tester :** dans Safari, sur la page d'une bague, touche Partager, puis **Glane**, puis choisis le tableau. Ouvre l'app : la bague est là, avec son image si le site la fournit.

### Raccourci « Glane photo » (captures et photos)

1. Crée un nouveau raccourci « Glane photo ».
2. Touche ⓘ, active **Afficher dans la feuille de partage**, puis choisis le type **Images**.
3. Ajoute les actions suivantes, dans cet ordre :
   1. **Convertir l'image** (Entrée du raccourci) en **JPEG**.
   2. **Redimensionner l'image** à une largeur de **1400**.
   3. **Encoder en base64**. Dans les options, mets **Retours à la ligne : Aucun**.
   4. Les mêmes actions que pour le raccourci « Glane » : **Obtenir le contenu de l'URL** (liste des tableaux), **Séparer le texte**, **Choisir dans la liste**.
   5. **Obtenir le contenu de l'URL** en `POST`, comme au-dessus, avec le même en-tête. Seul le corps JSON change :
      - `image_base64` = la variable **Texte encodé en base64** ;
      - `board` = la variable **Élément choisi**.
   6. **Afficher la notification**.

**Pour tester :** fais une capture d'écran Instagram, touche Partager, puis **Glane photo**.

Astuce : si tu crées un nouveau tableau dans l'app, il apparaît automatiquement dans la liste des Raccourcis.

---

## Limites connues du MVP

- **Pas sur l'App Store.** C'est une web app installée. Pour le store, voir la suite du projet.
- **Des sites bloquent la lecture automatique.** Beaucoup de marques de luxe, Instagram et TikTok le font. Dans ce cas l'app affiche une carte avec le logo du site : partage plutôt une capture.
- **Une seule utilisatrice, protégée par ton code.** Ne partage ni le code ni tes Raccourcis.
- **Les images sont accessibles par lien direct.** Leurs adresses sont longues et aléatoires, mais publiques pour qui les connaît. N'y mets rien de confidentiel.
- **Supabase met en pause les projets gratuits inactifs.** Si l'app ne charge plus après une longue pause, relance le projet depuis le tableau de bord Supabase.
- **La formule gratuite de Vercel est réservée à un usage non commercial.** Il faudra passer à une formule payante le jour où Glane devient un produit.

## En cas de problème

- **« Variables d'environnement manquantes »** : vérifie les trois variables dans Vercel, puis refais un **Redeploy**.
- **« Code invalide »** : le code tapé doit être identique à `GLANE_CODE`, majuscules comprises.
- **Les images ne s'enregistrent pas** : vérifie que le script SQL a bien créé le bucket `glane`, dans **Storage** sur Supabase. Si tu utilises une clé `sb_secret_…`, essaie la clé `service_role` des anciennes clés.
- **Le Raccourci renvoie une erreur** : vérifie l'en-tête `x-glane-code` et que le corps de la requête est bien en JSON.
