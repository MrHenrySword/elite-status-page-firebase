'use strict';

const { CORS_ALLOWED_ORIGINS } = require('../lib/constants');
const { appendVary } = require('../lib/helpers');

function isOriginAllowed(req, origin) {
	if (!origin) return true;
	if (CORS_ALLOWED_ORIGINS.length > 0) return CORS_ALLOWED_ORIGINS.includes(origin);
	const host = String(req.headers.host || '').trim();
	if (!host) return false;
	return origin === `http://${host}` || origin === `https://${host}`;
}

function applyCorsHeaders(req, res) {
	const origin = req.headers.origin;
	if (origin && isOriginAllowed(req, origin)) {
		res.setHeader('Access-Control-Allow-Origin', origin);
		res.setHeader('Access-Control-Allow-Credentials', 'true');
		res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
		res.setHeader('Vary', appendVary(res.getHeader('Vary'), 'Origin'));
	}
}

function corsMiddleware(req, res, next) {
	const origin = req.headers.origin;
	const allowed = isOriginAllowed(req, origin);
	applyCorsHeaders(req, res);
	if (origin && !allowed) {
		if (req.method === 'OPTIONS') return res.status(403).end();
		return res.status(403).json({ error: 'Origin not allowed' });
	}
	if (req.method === 'OPTIONS') return res.status(204).end();
	next();
}

module.exports = { isOriginAllowed, applyCorsHeaders, corsMiddleware };
