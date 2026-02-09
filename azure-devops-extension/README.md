# Elite Status Azure DevOps Extension

This package turns the status application into an installable Azure DevOps extension hub.

## What it provides

- Project hub page inside Azure DevOps:
  - `Code > Status`
  - `Boards > Status`
  - `Pipelines > Status`
- Real-time status summary from your deployed status API
- Direct links to the public status page and admin page

## 1) Configure extension metadata

Edit `vss-extension.json`:

- `publisher`
- `version`
- `id` (if you need an org-specific fork)

## 2) Configure backend endpoints

Edit `extension-config.json`:

- `apiBaseUrl`: Required. Base URL of your deployed API, for example `https://status.company.com`
- `defaultProjectSlug`: Optional fallback slug
- `projectSlugMap`: Optional mapping from Azure DevOps project name to status project slug
- `publicPageUrlTemplate`: Optional. Example `https://status.company.com/p/{slug}`
- `adminPageUrl`: Optional. Example `https://status.company.com/admin.html`

## 3) CORS for Azure DevOps origin

Your backend must allow requests from Azure DevOps UI origins. Add these to `CORS_ORIGIN`:

- `https://dev.azure.com`
- `https://<your-org>.visualstudio.com` (if your org uses this domain)

## 4) Package and publish

```bash
cd azure-devops-extension
npm install
npm run package
# then publish/share when ready
npm run publish
```

`npm run validate` fails if placeholder URLs are still present in `extension-config.json`.

## CI/CD Workflow

Repository workflow: `.github/workflows/azure-devops-extension.yml`

- Every extension change runs validation + VSIX packaging
- VSIX artifact is uploaded as `elite-status-vsix`
- Publish runs on:
  - Tag push (`v*`)
  - Manual dispatch with `publish=true`

Required GitHub secret:

- `AZDO_MARKETPLACE_PAT`: Marketplace Personal Access Token with extension publish permissions
