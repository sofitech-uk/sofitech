# sofitech MCP Demo — Free Tier Setup

Upload PDFs, ask Claude questions about them via MCP. Everything free.

**Stack:**
- MCP Server → Render free tier (Node.js)
- Database + Vector search → Supabase free tier
- Embeddings → OpenAI text-embedding-3-small (~£0.02/1000 pages)
- Keepalive → UptimeRobot free (pings Render every 5 min)

---

## Step 1 — Supabase (5 min)

1. Go to **supabase.com** → Create account → New project
2. Name it `sofitech-mcp`, choose a region close to you, set a DB password
3. Wait ~2 min for it to spin up
4. Go to **SQL Editor** → New query → paste contents of `sql/schema.sql` → Run
5. Go to **Project Settings → API**:
   - Copy **Project URL** → this is your `SUPABASE_URL`
   - Copy **service_role** key (under "Project API keys") → this is your `SUPABASE_SERVICE_KEY`
   - ⚠ Keep the service_role key secret — it bypasses all security

---

## Step 2 — OpenAI API key (2 min)

1. Go to **platform.openai.com** → API Keys → Create new key
2. Add ~$5 credit (more than enough for hundreds of PDFs)
3. Copy the key → this is your `OPENAI_API_KEY`

---

## Step 3 — Generate your client token (30 sec)

Run this in your terminal:
```bash
node -e "console.log('sft_' + require('crypto').randomBytes(24).toString('hex'))"
```
Save the output — this is your `CLIENT_TOKEN_NAWSHAD`.

---

## Step 4 — Ingest your PDFs locally (5 min)

```bash
# Clone or download this repo
cd sofitech-mcp-demo

# Copy .env.example to .env and fill in your values
cp .env.example .env
# Edit .env — add your SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY, CLIENT_TOKEN_NAWSHAD

# Install dependencies
npm install

# Upload a single PDF
node scripts/ingest.js --client nawshad --file ./your-document.pdf

# Upload a whole folder
node scripts/ingest.js --client nawshad --dir ./your-docs-folder

# Specify a document type (precedent | contract | policy | general)
node scripts/ingest.js --client nawshad --file ./lease-template.pdf --type precedent
```

You'll see progress: extracted N words → split into N chunks → ingested N/N chunks.

---

## Step 5 — Deploy to Render (10 min)

1. Push this code to a **GitHub repo** (public or private)
   ```bash
   git init
   git add .
   git commit -m "sofitech MCP server"
   gh repo create sofitech-mcp --private --push --source=.
   ```

2. Go to **render.com** → Sign up (free, no credit card) → New → Web Service

3. Connect your GitHub repo

4. Settings:
   - **Name:** sofitech-mcp
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free

5. Add **Environment Variables** (click "Add Environment Variable" for each):
   - `SUPABASE_URL` → your value
   - `SUPABASE_SERVICE_KEY` → your value
   - `OPENAI_API_KEY` → your value
   - `CLIENT_TOKEN_NAWSHAD` → your generated token

6. Click **Create Web Service** → wait ~3 min to deploy

7. Your MCP URL will be: `https://sofitech-mcp.onrender.com/mcp`

8. Test it: `curl https://sofitech-mcp.onrender.com/health`
   → `{"ok":true,"service":"sofitech-mcp"}`

---

## Step 6 — Keep Render awake for free (2 min)

Render free tier sleeps after 15 min of inactivity.
Fix with UptimeRobot (free, pings every 5 min):

1. Go to **uptimerobot.com** → Register → Add New Monitor
2. Monitor type: **HTTP(s)**
3. URL: `https://sofitech-mcp.onrender.com/health`
4. Monitoring interval: **5 minutes**
5. Save → your server now stays awake 24/7 for free

---

## Step 7 — Connect Claude to your MCP (2 min)

1. Open **Claude.ai** → click your avatar → **Settings**
2. Go to **Integrations** (or "MCP Servers" depending on your plan)
3. Click **Add Integration**:
   - **Name:** sofitech Docs
   - **URL:** `https://sofitech-mcp.onrender.com/mcp`
   - **Header name:** `Authorization`
   - **Header value:** `Bearer sft_your_token_here`
4. Save → Claude now has access to your document tools

---

## Step 8 — Try it

Ask Claude:
- *"What documents do I have available?"*
- *"Search my documents for anything about break clauses"*
- *"Ask the document lease-template.pdf: what are the tenant obligations?"*
- *"Show me my recent activity log"*

Claude will call your MCP tools and answer based on your actual PDFs.

---

## Adding more documents later

Just run the ingest script again — no server restart needed:
```bash
node scripts/ingest.js --client nawshad --file ./new-document.pdf
```

## Adding another client

1. Add a new env var on Render: `CLIENT_TOKEN_ACMEFIRM=sft_newtoken...`
2. Redeploy (or Render auto-deploys if you push to GitHub)
3. Ingest their docs: `node scripts/ingest.js --client acmefirm --dir ./acme-docs`
4. Give them their URL + token

---

## Cost summary

| Service | Cost |
|---|---|
| Render (web service) | Free |
| Supabase (DB + pgvector) | Free |
| UptimeRobot (keepalive) | Free |
| OpenAI embeddings | ~£0.02 per 1000 pages |
| **Total running cost** | **~£0/mo** |

The only real cost is OpenAI embeddings at ingest time.
A 50-page PDF costs roughly £0.001. Negligible.
