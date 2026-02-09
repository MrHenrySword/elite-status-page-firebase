const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'extension-config.json');
const raw = fs.readFileSync(file, 'utf8');
const config = JSON.parse(raw);
const manifestFile = path.join(__dirname, '..', 'vss-extension.json');
const manifestRaw = fs.readFileSync(manifestFile, 'utf8');
const manifest = JSON.parse(manifestRaw);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!config || typeof config !== 'object') {
  fail('extension-config.json must contain a JSON object.');
}

if (!config.apiBaseUrl || !/^https?:\/\//i.test(config.apiBaseUrl)) {
  fail('extension-config.json: apiBaseUrl must be a valid http/https URL.');
}

if (String(config.apiBaseUrl).includes('your-status-api.example.com')) {
  fail('extension-config.json: replace placeholder apiBaseUrl before packaging.');
}

if (config.publicPageUrlTemplate && String(config.publicPageUrlTemplate).includes('your-status-site.example.com')) {
  fail('extension-config.json: replace placeholder publicPageUrlTemplate before packaging.');
}

if (config.adminPageUrl && String(config.adminPageUrl).includes('your-status-site.example.com')) {
  fail('extension-config.json: replace placeholder adminPageUrl before packaging.');
}

if (!manifest.publisher || String(manifest.publisher).includes('your-publisher-id')) {
  fail('vss-extension.json: replace placeholder publisher before packaging.');
}

console.log('Extension config validation passed.');
