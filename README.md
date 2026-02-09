# Elite Status Page

This repository now follows an extension-first architecture:

- Status backend and admin API run on Firebase Hosting + Cloud Functions + Firestore
- Azure DevOps installable extension package lives in `azure-devops-extension/`
- Legacy Platform tab/settings have been removed from UI and backend

## Repository Structure

- `functions/`: Express API runtime, Firebase function entrypoint, static admin/public UI
- `hosting/`: Firebase hosting root
- `azure-devops-extension/`: Azure DevOps extension manifest, hub UI, packaging scripts

## Backend Architecture

- Hosting serves static assets from `functions/public`
- Hosting rewrites `/api/**` and `/health` to Cloud Function `api`
- Data is persisted in Firestore collections:
  - `status_meta/main` (nextId, migration metadata)
  - `status_users/{id}`
  - `status_projects/{id}`
  - `status_public_projects/{id}`
  - `status_audit/{autoId}`

## Local Setup

1. Install prerequisites
- Node.js 20+
- Firebase CLI: `npm i -g firebase-tools`

2. Configure Firebase project

```bash
firebase login
firebase use --add
```

3. Configure function environment

```bash
cp functions/.env.example functions/.env
```

Required values:
- `JWT_SECRET` (32+ chars)
- `INITIAL_ADMIN_EMAIL`
- `INITIAL_ADMIN_PASSWORD`
- `CORS_ORIGIN` (include your deployed frontend domains)

4. Install and run

```bash
cd functions
npm install
npm run serve
```

## Deploy Backend

```bash
firebase deploy --only functions,hosting,firestore:rules
```

## Azure DevOps Extension

The extension package is independent and production-oriented.

1. Configure `azure-devops-extension/vss-extension.json`
- Set `publisher`
- Set extension `id`/`version`

2. Configure `azure-devops-extension/extension-config.json`
- `apiBaseUrl` (required)
- Optional `defaultProjectSlug`
- Optional `projectSlugMap`
- Optional `publicPageUrlTemplate`
- Optional `adminPageUrl`

3. Package and publish

```bash
cd azure-devops-extension
npm install
npm run package
npm run publish
```

`npm run validate` prevents packaging when placeholder URLs are still present.

The extension contributes the same `Status` hub in:
- `Code`
- `Boards`
- `Pipelines`

CI workflow for extension packaging/publishing:
- `.github/workflows/azure-devops-extension.yml`
- requires secret: `AZDO_MARKETPLACE_PAT`

4. CORS requirement
- Ensure backend `CORS_ORIGIN` allows Azure DevOps UI origins such as:
  - `https://dev.azure.com`
  - `https://<your-org>.visualstudio.com`
