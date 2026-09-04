# मुंबई ड्राइवर टिप्स

Mumbai cab driver daily tip app — deployed on Netlify.

## Deploy in 5 minutes

### Step 1 — GitHub
1. Create a new GitHub repo (free account fine)
2. Upload all these files into it

### Step 2 — Netlify
1. Go to netlify.com → Sign up free
2. Click **Add new site → Import from GitHub**
3. Select your repo
4. Build settings:
   - Build command: *(leave blank)*
   - Publish directory: `public`
5. Click **Deploy site**
6. Your app is live at `https://random-name.netlify.app`

### Step 3 — Custom URL (optional)
In Netlify → Site settings → Domain management → Add custom domain
Example: `mumbaidrivertips.netlify.app` (free subdomain, just rename it)

### Step 4 — Nightly auto-refresh (optional)
1. In Netlify → Site → Deploys → Build hooks → Add hook → copy the URL
2. In GitHub repo → Settings → Secrets → New secret
   - Name: `NETLIFY_DEPLOY_HOOK`
   - Value: paste the Netlify hook URL
3. GitHub Actions will now trigger a fresh deploy every night at 9 PM IST

## How it works

- Drivers open the URL on their phone
- App calls `/.netlify/functions/get-tips` (serverless Node.js)
- Function scrapes insider.in + BookMyShow + airport data
- Returns top 3 scored tips in Hindi
- Drivers tap "ग्रुप में शेयर करो" to share the link on WhatsApp

## Files

```
public/
  index.html      ← the driver-facing app
  zones.json      ← Mumbai MMR zone config (16 zones)
  manifest.json   ← PWA — drivers can install on home screen

netlify/
  functions/
    get-tips.js   ← serverless scraper (runs on Netlify edge)

.github/
  workflows/
    nightly.yml   ← optional nightly redeploy trigger
```

## Customise zones
Edit `public/zones.json` to add/remove/modify zones.
Push to GitHub → Netlify auto-deploys in ~30 seconds.
