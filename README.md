# ContentFlow — real deployment (Cloudflare)

This turns ContentFlow from a Claude Artifact into a real, independently-hosted website with:
- **Real shared data** (Cloudflare D1) — every device/teammate sees the same calendar, queue, settings.
- **Real video/photo storage** (Cloudflare R2) — uploads are actually stored and rewatchable, not just a thumbnail.
- **Real hosting** (Cloudflare Workers, with static assets) — a real URL, not a private Claude Artifact link.

It's deployed automatically from GitHub — Cloudflare rebuilds and redeploys every time this repo's
`main` branch changes. You already did the GitHub connection. What's left is a one-time infrastructure
setup: creating the database and the storage bucket. Everything below runs in **your own Mac Terminal**.

## One-time setup

**1. Install the Cloudflare CLI (if you don't have it yet)**
```
npm install -g wrangler
```

**2. Go into this folder** (adjust the path if you put it somewhere else)
```
cd ~/Documents/"Sanjugo Content Engine"/contentflow-app
```

**3. Log in to Cloudflare** (opens your browser, click "Allow")
```
wrangler login
```

**4. Create the database**
```
wrangler d1 create contentflow-db
```
This prints a block like:
```
[[d1_databases]]
binding = "DB"
database_name = "contentflow-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```
Open `wrangler.toml` in this folder (any text editor) and replace `REPLACE_WITH_D1_DATABASE_ID`
with that `database_id` value, then save.

**5. Create the database's one table**
```
wrangler d1 execute contentflow-db --remote --file=schema.sql
```

**6. Create the media storage bucket**
```
wrangler r2 bucket create contentflow-media
```

**7. Commit and push the updated wrangler.toml**
```
git add wrangler.toml
git commit -m "Add D1 database id"
git push
```
Pushing to `main` triggers Cloudflare to rebuild and deploy automatically — no manual deploy
command needed. Watch it under Workers & Pages → sanjugo-content-engine → Deployments.

Once it succeeds, your real live URL is shown at the top of that project's dashboard page
(something like `https://sanjugo-content-engine.<your-subdomain>.workers.dev`).

## Updating later

From now on, any update just needs `git push` to the `main` branch — Cloudflare picks it up and
redeploys automatically. No Terminal commands needed unless a future change adds new infrastructure
(another database table, another bucket, etc.), in which case I'll flag exactly what's needed.

## Important: this has no login wall yet

Right now, anyone with the live link can open and use the app — there's no password. Two ways to
lock it down, both free:

**Recommended — Cloudflare Access** (takes ~5 min, no app code changes needed):
1. Cloudflare dashboard → Zero Trust → Access → Applications → "Add an application" → "Self-hosted".
2. Point it at your `sanjugo-content-engine` domain.
3. Add a policy: "Allow" if email is in `cyrus@sanjugo.co.uk`, `marketing@sanjugo.co.uk`, `admin@sanjugo.co.uk`.
4. Anyone else who visits gets a one-time email code prompt instead of the app — free for up to 50 users.

This is the real version of the "admin allowlist" ContentFlow's Settings page already has —
Cloudflare Access enforces it at the front door, before your app even loads.

## Installing it like an app (once it's deployed)

ContentFlow is set up as an installable web app — no App Store needed:

- **iPhone (Safari):** open the site → tap the Share icon → "Add to Home Screen". It gets a real
  icon on the home screen and opens full-screen, no browser bar.
- **Android (Chrome):** open the site → Chrome shows an "Install app" prompt automatically (or:
  menu ⋮ → "Install app").
- **Mac/Windows (Chrome or Edge):** open the site → click the install icon (⊕ or a monitor icon)
  at the right end of the address bar → "Install".

Each of Cyrus, Yan Yan, and AI Dev can do this on their own phone/laptop — it's the same live
app either way, so everyone stays in sync in real time, just like opening the Instagram app.

Tell me once you've deployed (or if any step errors) and I'll help from there.

## Connecting the Google Drive content library

ContentFlow's **Content Library** lists every file in the "Sanjugo Marketing Contents Final" Drive folder.
Until Drive is connected it uses a bundled snapshot (`public/library.json`) and can't copy files out of Drive.

Recommended: **Connect Google Drive** (an admin signs in once; no key files). One-time setup in Google Cloud,
project "ContentFlow":
1. APIs & Services → enable **Google Drive API**.
2. Google Auth Platform → Get started → app name "ContentFlow", audience **Internal**.
3. Clients → Create client → **Web application** → Authorized redirect URI:
   `https://sanjugo-content-engine.rapid-dust-8baf.workers.dev/api/google/callback`
4. Terminal, in this folder: `wrangler secret put GOOGLE_CLIENT_ID` and `wrangler secret put GOOGLE_CLIENT_SECRET`
   (paste the values from step 3).
5. ContentFlow → Settings → **Connect Google Drive** → sign in as the folder owner → Allow. The library then
   refreshes live from Drive.

The refresh token is stored server-side in D1 (`google_auth` table, created automatically). Disconnect in Settings
revokes it. Alternative for organisations that allow service-account keys: put the key JSON in the
`GOOGLE_SERVICE_ACCOUNT` secret and share the folder with the service account as Viewer.

ContentFlow only ever *reads* the folder. Files used in a post are copied into R2 so they preview and play like
uploads; camera RAW photos come in as Drive's full-size JPEG. The folder ID is `LIBRARY_FOLDER_ID` in `wrangler.toml`.
