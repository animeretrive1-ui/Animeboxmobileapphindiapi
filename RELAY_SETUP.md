# Fixing the Vercel 403 — Cloudflare Worker Relay Setup

## Why this is needed

`streams.iqsmartgames.com` and `ssn.iqsmartgames.com` block requests that
originate from cloud-datacenter IP ranges (AWS, Vercel, etc.).  
The API works fine locally because your home/office IP is not on their blocklist.

The fix routes the two blocked upstream calls through a Cloudflare Worker,
whose IPs are not blocked.  Everything else (HLS proxy, stream extraction)
is unaffected.

---

## Step 1 — Deploy the Cloudflare Worker

### Option A — Wrangler CLI (recommended)

```bash
# Install wrangler if you haven't already
npm install -g wrangler

# Log in to Cloudflare
wrangler login

# Deploy from the cf-worker directory
cd cf-worker
npx wrangler deploy
```

Wrangler will print a URL like:
```
https://multimovieapi-relay.<your-subdomain>.workers.dev
```
Copy that URL — you'll need it in Step 2.

### Option B — Cloudflare Dashboard (no CLI)

1. Go to https://workers.cloudflare.com/ and sign in (free account is fine).
2. Click **Create a Worker**.
3. Replace the default code with the contents of `cf-worker/worker.js`.
4. Click **Save and Deploy**.
5. Copy the `*.workers.dev` URL shown at the top.

---

## Step 2 — Add the environment variable on Vercel

1. Open your project on https://vercel.com/dashboard.
2. Go to **Settings → Environment Variables**.
3. Add a new variable:

   | Name        | Value                                                    | Environment        |
   |-------------|----------------------------------------------------------|--------------------|
   | `RELAY_URL` | `https://multimovieapi-relay.<your-subdomain>.workers.dev` | Production (+ Preview) |

4. Click **Save**, then **Redeploy** your project (Vercel does not auto-apply
   env var changes to existing deployments).

---

## Step 3 — Verify it works

Hit your debug endpoint after redeployment:

```
https://<your-vercel-app>.vercel.app/api/debug
```

You should see `step1_slug.status: "success"` and `step2_embed.status: "success"`.

Then test the main endpoint:

```
https://<your-vercel-app>.vercel.app/api/extract?tmdbId=61663&season=1&episode=4&type=series
```

---

## Local development

`RELAY_URL` is intentionally **not** set in your local environment, so local
`npm run dev` continues to hit the upstream APIs directly — no Worker needed.

If you want to test the relay path locally, export the variable before starting:

```bash
# Windows CMD
set RELAY_URL=https://multimovieapi-relay.<your-subdomain>.workers.dev
node server.js

# PowerShell
$env:RELAY_URL="https://multimovieapi-relay.<your-subdomain>.workers.dev"
node server.js
```

---

## Cloudflare free tier limits

| Metric           | Free tier allowance |
|------------------|---------------------|
| Requests/day     | 100,000             |
| CPU time/request | 10 ms               |
| Bandwidth        | Unlimited           |

The relay only forwards small JSON API calls (Steps 1 & 2), so CPU time
per request is well under 1 ms. 100k requests/day is more than enough for
typical usage.
