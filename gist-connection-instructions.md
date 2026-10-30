# Adding Persistent Storage to a GitHub Pages Site
### via GitHub Gist + Cloudflare Worker

GitHub Pages is static — it can't run a backend or store data. This guide wires up a free, zero-server persistence layer using a **GitHub Gist as a tiny database** and a **Cloudflare Worker as a secure API proxy** that keeps your GitHub token out of the browser.

When you're done your page can:
- `GET`  `https://your-worker.workers.dev/progress` → read your JSON data
- `POST` `https://your-worker.workers.dev/progress` → write your JSON data

No server. No database. Completely free.

---

## Prerequisites

- A GitHub account with a repo that has GitHub Pages enabled
- A Cloudflare account (free tier is fine) at [dash.cloudflare.com](https://dash.cloudflare.com)
- Node.js installed locally

---

## Step 1 — Create a GitHub Gist

This is your database. It holds a single JSON file.

1. Go to **[gist.github.com](https://gist.github.com)**
2. Create a **Secret** gist (not public)
3. Name the file whatever makes sense for your project — e.g. `progress.json`, `data.json`, `state.json`
4. Set the content to `{}`
5. Click **Create secret gist**
6. Copy the **Gist ID** from the URL:

```
https://gist.github.com/YourUsername/7b44b22bea74e5b33238c0d3734beaf5
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                      this is your Gist ID
```

---

## Step 2 — Create a GitHub Personal Access Token (PAT)

The Worker needs this to read and write your Gist via the GitHub API.

1. Go to **[github.com/settings/tokens](https://github.com/settings/tokens)**
2. Click **Generate new token (classic)**
3. Give it a descriptive name (e.g. `my-project-gist`)
4. Check **only** the `gist` scope — nothing else
5. Click **Generate token** and copy it immediately (`ghp_...`)

> ⚠️ Never paste this token into any file that gets pushed to a public repo.
> GitHub scans public repos and auto-revokes tokens within seconds of them being exposed.

---

## Step 3 — Get a Cloudflare API Token

1. Go to **[dash.cloudflare.com](https://dash.cloudflare.com)** → click your profile icon (top right) → **My Profile**
2. Left sidebar → **API Tokens**
3. Click **Create Token**
4. Find the **"Edit Cloudflare Workers"** template → **Use template**
5. Click **Continue to summary** → **Create Token**
6. Copy the token (`cfut_...`)

Also note your **workers.dev subdomain** — go to **Workers & Pages** in the sidebar. It will say something like `yourname.workers.dev`. If you haven't set one yet, you'll be prompted to choose one now.

---

## Step 4 — Create the Worker project locally

> ⚠️ **One worker per project.** Each site needs its own uniquely-named worker — if you reuse the same name, deploying it will overwrite the existing worker for the other site. Name it after your project, e.g. `school-gist-proxy`, `livi-gist-proxy`.

Run these commands in any folder on your machine (this is separate from your GitHub Pages repo):

```sh
mkdir my-project-gist-proxy   # rename this to match your project
cd my-project-gist-proxy
npm init -y
npm install --save-dev wrangler
mkdir src
```

Create **`wrangler.toml`** — set `name` to match your folder:

```toml
name = "my-project-gist-proxy"
main = "src/index.js"
compatibility_date = "2024-01-01"
workers_dev = true
```

Create **`src/index.js`** — replace the two constants at the top with your values:

```js
const GIST_ID   = 'YOUR_GIST_ID_HERE';   // from Step 1
const GIST_FILE = 'progress.json';        // whatever you named your file
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
      'Accept':        'application/vnd.github+json',
      'User-Agent':    'gist-proxy/1.0',
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
        catch { return new Response('Gist contains invalid JSON', { status: 502, headers: CORS }); }
      }
      return new Response(JSON.stringify(data), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
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

## Step 5 — Deploy the Worker

Run these from inside the `gist-proxy/` folder:

```powershell
# PowerShell
$env:CLOUDFLARE_API_TOKEN='cfut_YOUR_TOKEN_HERE'
npx wrangler deploy
```

```bash
# bash / zsh
CLOUDFLARE_API_TOKEN='cfut_YOUR_TOKEN_HERE' npx wrangler deploy
```

You'll see output like:
```
Uploaded gist-proxy
Deployed gist-proxy triggers
  https://gist-proxy.yourname.workers.dev
```

That URL is your API endpoint. Copy it.

---

## Step 6 — Add your GitHub PAT as a secret

The PAT must never go in source code — store it as an encrypted Cloudflare secret instead:

```powershell
# PowerShell
$env:CLOUDFLARE_API_TOKEN='cfut_YOUR_TOKEN_HERE'
echo 'ghp_YOUR_PAT_HERE' | npx wrangler secret put GIST_PAT
npx wrangler deploy
```

```bash
# bash / zsh
CLOUDFLARE_API_TOKEN='cfut_YOUR_TOKEN_HERE'
echo 'ghp_YOUR_PAT_HERE' | npx wrangler secret put GIST_PAT
npx wrangler deploy
```

---

## Step 7 — Test it

```sh
# Read — should return {}
node -e "fetch('https://gist-proxy.yourname.workers.dev/progress').then(r=>r.json()).then(console.log)"

# Write
node -e "fetch('https://gist-proxy.yourname.workers.dev/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hello:'world'})}).then(r=>r.text()).then(console.log)"

# Read again — should now return { "hello": "world" }
node -e "fetch('https://gist-proxy.yourname.workers.dev/progress').then(r=>r.json()).then(console.log)"
```

---

## Step 8 — Use it in your GitHub Pages site

In your page's JavaScript:

```js
const WORKER_URL = 'https://gist-proxy.yourname.workers.dev/progress';

// Read data
async function load() {
  const r = await fetch(WORKER_URL, { cache: 'no-cache' });
  return r.ok ? r.json() : {};
}

// Write data
async function save(data) {
  await fetch(WORKER_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(data),
  });
}
```

That's it. Push your changes and GitHub Pages will serve the updated site within ~60 seconds.

---

## Redeployment reference

| Task | Command |
|---|---|
| Update Worker code | `npx wrangler deploy` (with `CLOUDFLARE_API_TOKEN` set) |
| Rotate GitHub PAT | `echo 'ghp_NEW' \| npx wrangler secret put GIST_PAT` then redeploy |
| View live error logs | [Cloudflare Dashboard → Workers → your worker → Observability](https://dash.cloudflare.com) |
| Reset data | Open the Gist → Edit → set file content to `{}` → save |

---

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| Worker returns `GIST_PAT secret missing` | Secret wasn't added or didn't propagate | Re-run `wrangler secret put GIST_PAT`, then redeploy |
| GitHub returns 403 `Request forbidden` | PAT was revoked (exposed in a public repo) | Generate a new PAT at [github.com/settings/tokens](https://github.com/settings/tokens), store it again, redeploy |
| Worker returns 1101 | JavaScript exception in Worker code | Check Cloudflare Observability logs for the real error |
| Data resets on every page load | POST is failing silently | Open DevTools → Network → check the POST request response |
| Gist file contains invalid JSON | Manual edit gone wrong | Reset the file content to `{}` in the Gist editor |
| `wrangler deploy` says "authentication error" | Cloudflare API token expired or wrong | Regenerate the token at [dash.cloudflare.com → API Tokens](https://dash.cloudflare.com/profile/api-tokens) |
