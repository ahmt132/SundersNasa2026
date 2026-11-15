# Putting the site on Cloudflare (free plan)

The site has two parts, and they go to two free Cloudflare services:

| Part | Size | Where | Why |
|---|---|---|---|
| The page (HTML, JavaScript, CSS) | ~3 MB | **Cloudflare Pages**, built from the GitHub repo | rebuilt on every push |
| The data (`web/public/data`) | ~4.8 GB, ~3,100 files, largest ~72 MB | **Cloudflare R2** bucket | Pages allows only 25 MB per file; R2 free plan has 10 GB and no download fees |

Below, `example.org` is your domain. The page will be at `https://example.org` and the data at
`https://data.example.org`.

## 1. Move the domain's DNS to Cloudflare (once)
1. Make a free account at dash.cloudflare.com → **Add a domain** → type your domain → Free plan.
2. Cloudflare shows two nameservers. At the company where you bought the domain, replace its
   nameservers with these two. The domain stays registered there; only DNS moves.
3. Wait until Cloudflare says the domain is **Active** (minutes to a few hours).

## 2. Data → R2 (once, then again whenever the data is rebuilt)
1. Dashboard → **R2 Object Storage** → turn on R2 (it asks for a card; the free plan has
   10 GB storage, 1 M uploads and 10 M reads a month, and nothing is charged inside those).
2. **Create bucket**, e.g. `burning-calendar-data`.
3. Bucket → **Settings** → **Custom Domains** → **Connect domain** → `data.example.org`.
4. R2 overview → **Manage API tokens** → **Create API token** → permission *Object Read & Write*,
   only this bucket. Keep the window open: you need the Access Key ID, the Secret Access Key and
   your Account ID (shown on the R2 overview page).
5. In PowerShell, in the project folder (the keys stay in this window only; never put them in a file
   that goes to GitHub):
   ```
   $env:R2_ACCOUNT_ID="..."; $env:R2_ACCESS_KEY_ID="..."; $env:R2_SECRET_ACCESS_KEY="..."
   $env:R2_BUCKET="burning-calendar-data"
   .\scripts\publish_data.ps1 -Origins https://example.org
   ```
   This writes the data (`export-static`), uploads it and sets the CORS rule that lets
   `example.org` (and `localhost:5173`) read it. The first upload sends 4.8 GB; later runs send
   only files that changed. Add `-SkipExport` to upload what is already in `web/public/data`.
6. Check: `https://data.example.org/index.json` opens in the browser.

## 3. Page → Cloudflare Pages (once; afterwards every `git push` redeploys)
1. Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → GitHub →
   pick the repository.
2. Build settings:
   - Framework preset: *None*
   - Root directory: `web`
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Environment variable: `VITE_DATA_URL` = `https://data.example.org`
3. **Save and Deploy**. It gets a `*.pages.dev` address; then **Custom domains** →
   **Set up a custom domain** → `example.org` (and `www.example.org` if you want it).

The Node version for the build comes from `web/.node-version`.

## When something does not work
- *"Data file … could not be loaded"*: open `https://data.example.org/index.json` directly.
  If it opens, the CORS rule is missing your page's address: run
  `.venv\Scripts\python scripts\upload_r2.py --cors https://example.org https://<project>.pages.dev`
  (it skips the files that are already there).
- Old numbers after a data rebuild: Cloudflare dashboard → your domain → **Caching** →
  **Purge everything** (the data is cached for an hour).
- Trying the page with the R2 data on your own computer: in `web/`, create `.env.local` with
  `VITE_DATA_URL=https://data.example.org` and run `npm run dev`. Delete the file to go back to
  the local `public/data` folder.

## Notes
- **Third-party map tiles** are loaded straight from their providers: Sentinel-2 cloudless and
  OpenStreetMap layers from EOX (maps.eox.at), daily imagery, Blue Marble and Black Marble from
  NASA GIBS. Sentinel-2 cloudless is CC BY-NC-SA 4.0: fine for a non-commercial Space Apps
  project with the attribution the map already shows; a commercial site would need a licence
  from EOX.
- The **FastAPI service** (`api/`) is not needed by the website and is not deployed here.
