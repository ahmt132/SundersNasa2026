# Putting the site on GoDaddy

The website is fully **static**: HTML, JavaScript and data files. All calculations run in the
visitor's browser, so it needs no Python, database or Node.js on the server. It works on any
GoDaddy **Web Hosting (cPanel / Linux)** plan, in the domain root or in a sub-folder.

It does **not** work with GoDaddy *Websites + Marketing* (the drag-and-drop site builder): that
product cannot host your own files. You need a plan with **cPanel** and **File Manager**.

## 1. Build (on your PC)

```
.\scripts\build_site.ps1
```

This writes the data files (`python -m pipeline.run export-static`) and builds the site into
`web\dist\`. Rebuild whenever the data changes (for example after importing the Drive zips).

## 2. Zip

Open `web\dist`, select **everything inside it** (`index.html`, `assets`, `data`, and the hidden
`.htaccess`; turn on *View → Hidden items* in Explorer to see it) and choose
*Send to → Compressed (zipped) folder*. Do not zip the `dist` folder itself, only its contents.

## 3. Upload

1. GoDaddy → *My Products* → *Web Hosting* → **Manage** → **cPanel Admin** → **File Manager**.
2. Open `public_html` (or make a sub-folder such as `public_html/fires` if the site should live at
   `yourdomain.com/fires/`).
3. **Upload** the zip, then right-click it → **Extract**. Delete the zip afterwards.
4. In File Manager *Settings*, tick *Show Hidden Files* and check that `.htaccess` is there.

## 4. Check

Open the site, then:

- the map shows imagery and the side panel shows key figures (data loaded);
- press **Copy share link**, open it in a private window: the same view must come back;
- download the calendar CSV once.

If the panel says "Data file … could not be loaded", the `data` folder is missing or was uploaded
one level too deep.

## Notes

- **HTTPS**: turn on the free SSL certificate in cPanel (*SSL/TLS Status*). The map's location
  button only works over HTTPS.
- **Size**: about 36 MB with the two current regions. The Amazon and Northern Australia add more
  (the hotspot files grow with the number of detections). This is well within cPanel plans.
- `.htaccess` turns on compression and caching. If a file of the site ever shows as plain text or
  downloads instead of opening, check that `.htaccess` was uploaded.
- **Third-party map tiles** are loaded straight from their providers: Sentinel-2 cloudless and
  OpenStreetMap layers from EOX (maps.eox.at), daily imagery, Blue Marble and Black Marble from
  NASA GIBS. Sentinel-2 cloudless is CC BY-NC-SA 4.0: fine for a non-commercial Space Apps
  project with the attribution the map already shows; a commercial site would need a licence
  from EOX.
- The **FastAPI service** (`api/`) is not needed by the website. It stays in the repository for
  programmatic access and needs a server that can run Python (a GoDaddy VPS can; shared cPanel
  hosting is not a reliable place for it).
