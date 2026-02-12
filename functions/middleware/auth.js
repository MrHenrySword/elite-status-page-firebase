'use strict';

const { AUTH_COOKIE_NAME, TOKEN_TTL_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS } = require('../lib/constants');
const { parseCookies } = require('../lib/helpers');
const { verifyToken, createToken } = require('../lib/jwt');
const { requestProtocol } = require('../services/domainService');

const loginRateBuckets = new Map();

// ── Token extraction ────────────────────────────────────────────────────

function tokenFromRequest(req) {
	const authHeader = req.headers.authorization || '';
	if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
	const cookies = parseCookies(req.headers.cookie);
	return cookies[AUTH_COOKIE_NAME] || '';
}

// ── Cookie helpers ──────────────────────────────────────────────────────

function authCookieOptions(req) {
	return {
		httpOnly: true,
		sameSite: 'lax',
		secure: requestProtocol(req, req.headers.host) === 'https',
		path: '/',
		maxAge: TOKEN_TTL_MS
	};
}

function setAuthCookieExpress(req, res, token) {
	res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions(req));
}

function clearAuthCookieExpress(req, res) {
	const opts = authCookieOptions(req);
	res.cookie(AUTH_COOKIE_NAME, '', { ...opts, maxAge: 0 });
}

// ── Client IP ───────────────────────────────────────────────────────────

function clientIp(req) {
	const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
	if (forwarded) return forwarded;
	return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ── Login rate limiting ─────────────────────────────────────────────────

function consumeLoginRateLimit(req, username) {
	const key = `${clientIp(req)}|${String(username || '').trim().toLowerCase() || 'unknown'}`;
	const now = Date.now();
	let entry = loginRateBuckets.get(key);
	if (!entry || entry.expiresAt <= now) {
		entry = { count: 0, expiresAt: now + RATE_LIMIT_WINDOW_MS };
	}
	entry.count += 1;
	loginRateBuckets.set(key, entry);

	if (loginRateBuckets.size > 5000) {
		for (const [k, v] of loginRateBuckets) {
			if (v.expiresAt <= now) loginRateBuckets.delete(k);
		}
	}
	return { key, allowed: entry.count <= RATE_LIMIT_MAX_REQUESTS };
}

function resetLoginRateLimit(key) {
	if (key) loginRateBuckets.delete(key);
}

// ── Express middleware ──────────────────────────────────────────────────

function authMiddleware(req, res, next) {
	const payload = verifyToken(tokenFromRequest(req));
	if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
	req.user = payload;
	next();
}

function loginRateLimitMiddleware(req, res, next) {
	const username = String((req.body && req.body.username) || '').trim().toLowerCase();
	const result = consumeLoginRateLimit(req, username);
	req.loginRateLimitKey = result.key;
	if (!result.allowed) return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
	next();
}

function requireAdmin(req, res, next) {
	if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
	next();
}

function requireEditor(req, res, next) {
	if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'editor')) {
		return res.status(403).json({ error: 'Forbidden' });
	}
	next();
}

module.exports = {
	tokenFromRequest,
	authCookieOptions,
	setAuthCookieExpress,
	clearAuthCookieExpress,
	clientIp,
	consumeLoginRateLimit,
	resetLoginRateLimit,
	authMiddleware,
	loginRateLimitMiddleware,
	requireAdmin,
	requireEditor,
	createToken
};
