# AV Studio Intelligence Boost — Deployment Setup

Complete these steps in order. Each step produces a value you paste into the next.
Estimated total time: 45–60 minutes, one time.

---

## Overview

The Intelligence Boost app deploys as a subfolder of your existing website:

```
apex-vector.com/           ← existing website (unchanged)
apex-vector.com/avs-boost/ ← Intelligence Boost app (new)
```

Both are served from the same GitHub repository (`james-elste/apex-vector`)
and the same GitHub Pages configuration. No new repo, no new hosting.

The app source code lives in `avs-boost-src/` within the repo.
A GitHub Actions workflow builds it and writes the compiled output to `avs-boost/`.
GitHub Pages serves `avs-boost/` automatically at `apex-vector.com/avs-boost/`.

---

## Prerequisites

- Global Admin access to your Microsoft 365 tenant (james.elste@apex-vector.com)
- Write access to `james-elste/apex-vector` on GitHub
- Node.js 18+ installed locally (for local testing only)

---

## STEP 1 — Add the App to the Existing Repository

Clone your existing repo locally if you haven't already:
```bash
git clone https://github.com/james-elste/apex-vector.git
cd apex-vector
```

Add two new items to the repo root:
- `avs-boost-src/` folder — the React source (provided in this package)
- `.github/workflows/deploy-avs-boost.yml` — the build workflow

```
apex-vector/
├── index.html              ← existing website (do not touch)
├── assessment.html         ← existing (do not touch)
├── CNAME                   ← existing (do not touch)
├── avs-boost-src/          ← NEW
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   └── src/
│       ├── main.jsx
│       └── App.jsx
└── .github/
    └── workflows/
        └── deploy-avs-boost.yml  ← NEW
```

Commit and push:
```bash
git add avs-boost-src/ .github/
git commit -m "feat: add AV Intelligence Boost app"
git push
```

The workflow triggers automatically. After 2–3 minutes an `avs-boost/` folder
appears at the repo root (committed by the workflow bot) and the app is live at:
**https://apex-vector.com/avs-boost/**

---

## STEP 2 — Enable GitHub Actions Permissions

If this is the first workflow in the repo:

1. Go to https://github.com/james-elste/apex-vector/settings/actions
2. **Actions permissions** → **Allow all actions and reusable workflows** → Save

The workflow needs write access to commit built files back to main:

1. **Settings → Actions → General → Workflow permissions**
2. Select **Read and write permissions** → Save

---

## STEP 3 — Register the App in Microsoft Entra ID

1. Go to https://portal.azure.com
2. **Microsoft Entra ID → App registrations → New registration**
3. Fill in:
   - **Name:** AV Studio Intelligence Boost
   - **Supported account types:** Accounts in any organizational directory (Multitenant)
   - **Redirect URI:** Leave blank
4. Click **Register**
5. Copy from the Overview page:
   - **Application (client) ID** → `YOUR_ENTRA_APP_CLIENT_ID`

### Application ID URI

1. **Expose an API → Add** next to Application ID URI
2. Set to:
   ```
   api://apex-vector.com/avs-boost/YOUR_ENTRA_APP_CLIENT_ID
   ```
3. Save

### Scope

1. **Expose an API → Add a scope**
   - Scope name: `access_as_user`
   - Who can consent: **Admins and users**
   - Admin consent display name: `Access AV Intelligence Boost as user`
   - State: Enabled
2. Add scope

### Authorize Teams Clients

In **Expose an API → Authorized client applications**, add both:

| Teams client | Client ID |
|---|---|
| Desktop | `1fec8e78-bce4-4aaf-ab1b-5451cc387264` |
| Web | `5e3ce6c0-2b1f-4285-8d4b-75ee78787346` |

For each: Add client application → paste ID → check `access_as_user` → Add.

### Graph Permissions

1. **API permissions → Add a permission → Microsoft Graph → Delegated**
2. Add `Sites.ReadWrite.All` and `User.Read`
3. **Grant admin consent for your tenant** → confirm

---

## STEP 4 — Create the SharePoint List

1. Go to your SharePoint tenant root
2. Create or navigate to a site called **AV Studio**
3. **Site contents → New → List** → Name: `DrillProgress`
4. Add columns:
   - **UserEmail** — Single line of text, mark as **indexed**
   - **ProgressData** — Multiple lines of text, plain text (not rich text)

### Get Site ID and List ID

In **Graph Explorer** (https://developer.microsoft.com/graph/graph-explorer):

**Site ID:**
```
GET https://graph.microsoft.com/v1.0/sites/YOUR_TENANT.sharepoint.com:/sites/AVStudio
```
Copy the full `id` field → `YOUR_SHAREPOINT_SITE_ID`

**List ID:**
```
GET https://graph.microsoft.com/v1.0/sites/YOUR_SHAREPOINT_SITE_ID/lists?$filter=displayName eq 'DrillProgress'
```
Copy the `id` field → `YOUR_SHAREPOINT_LIST_ID`

---

## STEP 5 — Update App Configuration

In `avs-boost-src/src/App.jsx`, replace the three values at the top of the file:

```javascript
const ENTRA_CLIENT_ID = "YOUR_ENTRA_APP_CLIENT_ID";   // Step 3
const SP_SITE_ID      = "YOUR_SHAREPOINT_SITE_ID";    // Step 4
const SP_LIST_ID      = "YOUR_SHAREPOINT_LIST_ID";    // Step 4
```

---

## STEP 6 — Update the Teams Manifest

In `teams-manifest/manifest.json`, replace:

| Placeholder | Value |
|---|---|
| `YOUR_TEAMS_APP_GUID` | New GUID from https://guidgenerator.com |
| `YOUR_ENTRA_APP_CLIENT_ID` | Application ID from Step 3 |

All URLs already reference `apex-vector.com/avs-boost/` — no other changes needed.

---

## STEP 7 — Deploy

```bash
git add avs-boost-src/src/App.jsx teams-manifest/manifest.json
git commit -m "config: set Entra ID and SharePoint IDs"
git push
```

Workflow re-runs, app rebuilds with real IDs. Live in ~3 minutes.

---

## STEP 8 — Create Icons and Package the Teams Manifest

Icons needed in `teams-manifest/`:
- `icon-192.png` — 192×192px, full color, dark background (AV logo)
- `icon-32.png` — 32×32px, white outline on transparent background

Package:
```bash
cd teams-manifest
zip avs-boost-teams-app.zip manifest.json icon-192.png icon-32.png
```

Upload to Teams:
1. Teams → **Apps → Manage your apps → Upload an app → Upload a custom app**
2. Select the zip → **Add**

---

## STEP 9 — Grant Guests SharePoint Access

Gmail guest users need explicit access to the AV Studio SharePoint site:

1. AV Studio SharePoint site → **Settings → Site permissions → Share site**
2. Add each guest email with **Read** permission

Do this when you onboard each new client.

---

## STEP 10 — Test with a Gmail Guest

1. Invite a test Gmail address as a guest to your Teams tenant
2. Join as the guest and open the Intelligence Boost tab
3. Complete 2–3 lessons, close Teams, reopen
4. Confirm progress persists
5. Verify a row exists in the `DrillProgress` SharePoint list for that email

---

## Client Offboarding

Delete the client's row in the `DrillProgress` SharePoint list.
Or via Graph Explorer:
```
DELETE https://graph.microsoft.com/v1.0/sites/YOUR_SP_SITE_ID/lists/YOUR_SP_LIST_ID/items/ITEM_ID
```

---

## Local Development

```bash
cd avs-boost-src
npm install
npm run dev
```

Open http://localhost:5173 — uses localStorage, no Teams auth required.

---

## Final Repo Structure

```
apex-vector/
├── index.html                   ← website (unchanged)
├── assessment.html              ← website (unchanged)
├── CNAME                        ← apex-vector.com (unchanged)
│
├── avs-boost-src/               ← app source (new)
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   └── src/
│       ├── main.jsx
│       └── App.jsx
│
├── avs-boost/                   ← compiled output (auto-generated)
│   ├── index.html
│   └── assets/
│
├── teams-manifest/              ← Teams app package (new)
│   ├── manifest.json
│   ├── icon-192.png
│   └── icon-32.png
│
└── .github/
    └── workflows/
        └── deploy-avs-boost.yml
```

---

## Troubleshooting

**Blank page at apex-vector.com/avs-boost/**
→ Confirm `vite.config.js` has `base: '/avs-boost/'`

**Workflow permission error**
→ Set Workflow permissions to Read and Write (Step 2)

**Graph 403 in Teams**
→ Grant admin consent for API permissions (Step 3)

**Guest auth fails**
→ Verify both Teams client IDs are in Authorized client applications (Step 3)

**Progress resets between sessions**
→ Guest needs SharePoint site access (Step 9)

**"Something went wrong" in Teams tab**
→ Open teams.microsoft.com in browser, F12 dev tools, check console
