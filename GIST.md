# GitHub Gist + Cloudflare Worker — Setup Guide

A minimal proxy that lets static pages (GitHub Pages, local files) read and write
a single GitHub Gist without exposing a Personal Access Token in the browser.

---

## Architecture

```
Browser (GitHub Pages)
  │
  ├─ GET  https://<worker>.workers.dev/progress   → reads Gist → returns JSON
  └─ POST https://<worker>.workers.dev/progress   → writes JSON → updates Gist
                │
        Cloudflare Worker
        (holds PAT as a secret — never in source code)
                │
        GitHub Gist API
        api.github.com/gists/<GIST_ID>
```

---

## Step 1 — Create a GitHub Gist

1. Go to https://gist.github.com
2. Create a **secret** gist with a file named `progress.json` (or name it depending on the project) containing `{}`
3. Copy the **Gist ID** from the URL:
   `https://gist.github.com/YourUsername/`**`551d7ee7f903132853aed1b4466d0c3b`**

---

## Step 2 — Create a GitHub Personal Access Token (PAT)

1. Go to https://github.com/settings/tokens
2. Click **Generate new token (classic)**
3. Give it a name (e.g. `school-progress`)
4. Check only the **`gist`** scope
5. Click **Generate token** and copy it — you will not see it again

> **Important:** Never commit this token to a public repo. GitHub will auto-revoke it
> within seconds of it being pushed to any public repository.

---

## Step 3 — Set up the Cloudflare Worker project

Prerequisites: Node.js installed, Cloudflare account at cloudflare.com.

```sh
# Create the project folder manually (do not use npm create cloudflare — it's interactive)
mkdir gist-proxy
cd gist-proxy
npm init -y
npm install --save-dev wrangler
mkdir src
```

Create `wrangler.toml`:
```toml
name = "gist-proxy"
main = "src/index.js"
compatibility_date = "2024-01-01"
workers_dev = true
```

Create `src/index.js`:
```js
const GIST_ID   = 'YOUR_GIST_ID_HERE';
const GIST_FILE = 'progress.json';
const GIST_URL  = 'https://api.github.com/gists/' + GIST_ID;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const pat = env.GIST_PAT;
    if (!pat) return new Response('GIST_PAT secret missing', { status: 500, headers: CORS });

    const auth = {
      'Authorization': 'Bearer ' + pat,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'gist-proxy/1.0'
    };

    if (request.method === 'GET') {
      const res = await fetch(GIST_URL, { headers: auth });
      if (!res.ok) {
        const text = await res.text();
        return new Response('GitHub error ' + res.status + ': ' + text, { status: 502, headers: CORS });
      }
      const gist = await res.json();
      const file = gist.files && gist.files[GIST_FILE];
      let data = {};
      if (file && file.content) {
        try { data = JSON.parse(file.content); }
        catch { return new Response('Gist file contains invalid JSON', { status: 502, headers: CORS }); }
      }
      return new Response(JSON.stringify(data), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    if (request.method === 'POST') {
      const body    = await request.json();
      const payload = { files: { [GIST_FILE]: { content: JSON.stringify(body, null, 2) } } };
      const res = await fetch(GIST_URL, {
        method:  'PATCH',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        return new Response('GitHub error ' + res.status + ': ' + text, { status: 502, headers: CORS });
      }
      return new Response('ok', { status: 200, headers: CORS });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};
```

---

## Step 4 — Get a Cloudflare API Token

1. Go to https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
2. Click **Create Token** → use the **"Edit Cloudflare Workers"** template
3. Click **Continue to summary** → **Create Token**
4. Copy the token (starts with `cfut_...`)

---

## Step 5 — Register a workers.dev subdomain

1. Go to https://dash.cloudflare.com → **Workers & Pages**
2. If no subdomain is set, open the **Account Details** panel and set one
   (e.g. `yourname` → your worker will be at `gist-proxy.yourname.workers.dev`)

---

## Step 6 — Deploy

Run all commands from inside the `gist-proxy/` directory.

```sh
# Deploy the worker (set CLOUDFLARE_API_TOKEN in the environment)
$env:CLOUDFLARE_API_TOKEN='cfut_...'   # PowerShell
npx wrangler deploy

# Store the GitHub PAT as a Cloudflare secret (never goes in source code)
echo 'ghp_YOUR_PAT_HERE' | npx wrangler secret put GIST_PAT

# Redeploy to pick up the new secret
npx wrangler deploy
```

Your worker is now live at:
```
https://gist-proxy.yourname.workers.dev/progress
```

---

## Step 7 — Test

```sh
# Read (should return {})
node -e "fetch('https://gist-proxy.yourname.workers.dev/progress').then(r=>r.json()).then(console.log)"

# Write
node -e "fetch('https://gist-proxy.yourname.workers.dev/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({test:1})}).then(r=>r.text()).then(console.log)"
```

---

## Gotchas

| Problem | Cause | Fix |
|---|---|---|
| Worker throws `SyntaxError: Unexpected token 'R'` | Gist file had invalid/corrupted content; `JSON.parse()` crashed | Wrap `JSON.parse(file.content)` in try/catch (already done in the template above) |
| Worker returns 1101 | JavaScript exception in Worker code | Check Cloudflare Observability logs for the actual error message |
| GitHub returns 403 `Request forbidden` | PAT was revoked (GitHub auto-revokes tokens pushed to public repos) | Generate a new PAT, re-run `wrangler secret put GIST_PAT`, redeploy |
| `cache: 'no-store'` causes crash | Not a valid fetch option in the Workers runtime | Remove it — Workers don't cache subrequests by default anyway |
| Secret not updating after `wrangler secret put` | Edge propagation delay | Delete the secret, re-add it, then redeploy: `wrangler secret delete GIST_PAT` |

---

## Redeployment (future updates)

```sh
cd gist-proxy
$env:CLOUDFLARE_API_TOKEN='cfut_...'
npx wrangler deploy
```

To rotate the PAT:
```sh
echo 'ghp_NEW_TOKEN' | npx wrangler secret put GIST_PAT
npx wrangler deploy
```
