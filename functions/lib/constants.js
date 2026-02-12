'use strict';

const path = require('path');
const fs = require('fs');

const FUNCTIONS_DIR = path.resolve(__dirname, '..');
const AZURE_DATA_DIR = '/home/data';
const isAzure = !!process.env.WEBSITE_SITE_NAME;
const isCloudFunctions = !!process.env.K_SERVICE || !!process.env.FUNCTION_TARGET;
const dataDir = isAzure ? AZURE_DATA_DIR : isCloudFunctions ? '/tmp' : FUNCTIONS_DIR;

if (isAzure && !fs.existsSync(AZURE_DATA_DIR)) {
	fs.mkdirSync(AZURE_DATA_DIR, { recursive: true });
}

module.exports = {
	FUNCTIONS_DIR,
	DATA_FILE: path.join(dataDir, 'data.json'),
	LOG_FILE: path.join(dataDir, 'audit.log'),
	PUBLIC_DIR: path.join(FUNCTIONS_DIR, 'public'),
	AUTH_COOKIE_NAME: 'statusPageToken',
	TOKEN_TTL_MS: 24 * 60 * 60 * 1000,
	BCRYPT_ROUNDS: Math.max(10, Math.min(15, parseInt(process.env.BCRYPT_ROUNDS || '12', 10) || 12)),
	RATE_LIMIT_WINDOW_MS: Math.max(1000, parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10) || 900000),
	RATE_LIMIT_MAX_REQUESTS: Math.max(1, parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '10', 10) || 10),
	GENERAL_RATE_LIMIT_WINDOW_MS: 60 * 1000,
	GENERAL_RATE_LIMIT_MAX: 120,
	PASSWORD_MIGRATION_VERSION: 1,
	CORS_ALLOWED_ORIGINS: String(process.env.CORS_ORIGIN || '').split(',').map(v => v.trim()).filter(Boolean),
	ALLOWED_DISABLED_TABS: new Set(['components', 'incidents', 'maintenance', 'subscribers', 'projects', 'users', 'settings']),
	isAzure,
	isCloudFunctions,
	dataDir
};
