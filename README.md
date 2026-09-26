# ContentFlow — real deployment (Cloudflare)

This turns ContentFlow from a Claude Artifact into a real, independently-hosted website with:
- **Real shared data** (Cloudflare D1) — every device/teammate sees the same calendar, queue, settings.
- **Real video/photo storage** (Cloudflare R2) — uploads are actually stored and rewatchable, not just a thumbnail.
- **Real hosting** (Cloudflare Pages) — a real URL, not a private Claude Artifact link.

Everything below runs in **your own Mac Terminal** (not through Claude) — that's the app on your
Applications, called "Terminal". Copy each command, paste it in, press enter, wait for it to finish,
then move to the next one. It's about 10 minutes total.

## One-time setup

**1. Install the Cloudflare CLI (if you don't have it yet)**
```
npm install -g wrangler
```

**2. Go into this folder**
```
cd ~/Documents/contentflow-app
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

**7. Deploy**
```
wrangler pages deploy public --project-name=contentflow
```
The first time, it may ask to create the Pages project — say yes. At the end it prints your
real live URL, something like `https://contentflow.pages.dev`. Open it — that's the real app.

**If step 7 complains it can't find the D1/R2 bindings:** open the Cloudflare dashboard →
Workers & Pages → contentflow → Settings → Functions, and add the bindings manually there:
- D1 database binding: variable name `DB` → database `contentflow-db`
- R2 bucket binding: variable name `MEDIA` → bucket `contentflow-media`

Then redeploy with the same command from step 7.

## Updating later

Whenever I hand you new files for this project, just re-run:
```
wrangler pages deploy public --project-name=contentflow
```
from inside `~/Documents/contentflow-app`. That's the only command you'll need for future updates.

## Important: this has no login wall yet

Right now, anyone with the `https://contentflow.pages.dev` link can open and use the app —
there's no password. Two ways to lock it down, both free:

**Recommended — Cloudflare Access** (takes ~5 min, no app code changes needed):
1. Cloudflare dashboard → Zero Trust → Access → Applications → "Add an application" → "Self-hosted".
2. Point it at your `contentflow.pages.dev` domain.
3. Add a policy: "Allow" if email is in `cyrus@sanjugo.co.uk`, `marketing@sanjugo.co.uk`, `admin@sanjugo.co.uk`.
4. Anyone else who visits gets a one-time email code prompt instead of the app — free for up to 50 users.

This is the real version of the "admin allowlist" ContentFlow's Settings page already has —
Cloudflare Access enforces it at the front door, before your app even loads.

Tell me once you've deployed (or if any step errors) and I'll help from there.
