# 3E Elite Status - Firebase/Firestore Copy

This is a deployment copy of your status-page project for Firebase Hosting + Cloud Functions + Firestore.
Your original project stays unchanged.

## Architecture in this copy

- Hosting rewrites all traffic to one Cloud Function: `api`
- The Function runs your Express server from `functions/server.js`
- Server state is persisted to Firestore collections:
  - `status_meta/main` (platform settings, nextId, migration metadata)
  - `status_users/{id}`
  - `status_projects/{id}`
  - `status_audit/{autoId}`
- Local `data.json`/`audit.log` are only runtime cache files in the Function environment.

This keeps your existing server logic while giving you Firestore-backed persistence for deploy.

## 1) Prerequisites

- Node.js 20+
- Firebase CLI: `npm i -g firebase-tools`
- A Firebase project with Billing enabled (for 2nd gen Functions)

## 2) Configure project

From this folder:

```bash
firebase login
firebase use --add
```

Create a local `.firebaserc` from `.firebaserc.example` and set your project id.

## 3) Configure environment variables

Copy:

```bash
cp functions/.env.example functions/.env
```

Then set at minimum:

- `JWT_SECRET` (required, 32+ chars)
- `INITIAL_ADMIN_EMAIL`
- `INITIAL_ADMIN_PASSWORD`
- `CORS_ORIGIN` (your web.app/custom domains)

## 4) Install dependencies

```bash
cd functions
npm install
cd ..
```

## 5) Deploy

```bash
firebase deploy --only functions,hosting,firestore:rules
```

After deploy, open your Hosting URL.

## Notes

1. This copy now uses Firestore collections (not a single document).
2. `server.js` is still your original app logic; persistence is adapted in `functions/index.js`.
3. For very large workloads, you can further normalize project internals (components/incidents/maintenances) into dedicated subcollections.
