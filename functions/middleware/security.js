'use strict';

function applySecurityHeaders(res) {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('X-Frame-Options', 'DENY');
	res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
	res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function securityMiddleware(req, res, next) {
	applySecurityHeaders(res);
	next();
}

module.exports = { applySecurityHeaders, securityMiddleware };
