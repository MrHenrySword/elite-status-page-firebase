'use strict';

const crypto = require('crypto');
const { TOKEN_TTL_MS } = require('./constants');

const SECRET = String(process.env.JWT_SECRET || '').trim();
if (!SECRET || SECRET.length < 32) {
	throw new Error('JWT_SECRET must be set and at least 32 characters long.');
}

function createToken(payload) {
	const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
	const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
	const sig = crypto.createHmac('sha256', SECRET).update(header + '.' + body).digest('base64url');
	return header + '.' + body + '.' + sig;
}

function verifyToken(token) {
	try {
		const [header, body, sig] = token.split('.');
		if (!header || !body || !sig) return null;
		const expectedSig = crypto.createHmac('sha256', SECRET).update(header + '.' + body).digest('base64url');
		const sigBuf = Buffer.from(sig, 'base64url');
		const expectedBuf = Buffer.from(expectedSig, 'base64url');
		if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
		const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
		if (payload.exp < Date.now()) return null;
		return payload;
	} catch {
		return null;
	}
}

module.exports = { createToken, verifyToken };
