# Botany Lab — Setup

## 1 · Connect the Google Sheet (~2 minutes, once)

1. Open the **Botany R&D — Shot Log** spreadsheet in Google Sheets.
2. **Extensions → Apps Script**. Delete any placeholder code and paste in the contents of [`apps-script/Code.gs`](apps-script/Code.gs). Save.
3. **Deploy → New deployment** → gear icon → **Web app**:
   - Description: `botany lab sync`
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy**, authorize when prompted, and copy the **Web app URL** (ends in `/exec`).
5. In the Botany Lab app: **Settings → Google Sheet sync URL** → paste → **Test connection** should toast "Connected to sheet ✓".

> The script writes to a tab named **Shots** that it creates itself with the full header row (including `water_temp_c`). The tab that came with the spreadsheet is just a placeholder — feel free to delete it once **Shots** appears.

Every phone with that URL in Settings appends to the same sheet. Set a **Barista name** per phone so rows say who pulled the shot. Retries are de-duplicated by shot id, so a flaky connection never double-logs.

> If you later edit Code.gs, use **Deploy → Manage deployments → edit → New version** — the URL stays the same.

## 2 · Install on phones

Open the GitHub Pages URL, then:

- **iPhone (Safari)**: Share → **Add to Home Screen**
- **Android (Chrome)**: menu ⋮ → **Add to Home screen** / **Install app**

It runs full-screen and works offline; shots queue and sync when back online.

## 3 · Deploy updates

The app lives at https://fixerseven.github.io/botanyrnd/ — GitHub Pages serves the `gh-pages` branch:

```bash
git add -A && git commit -m "update" && git push && git push origin main:gh-pages
```

Pages redeploys automatically in ~1 minute. Phones pick up the new version on next launch (the service worker refreshes in the background; force-quit and reopen to be sure).
