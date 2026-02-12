'use strict';

const express = require('express');
const router = express.Router();
const { getDb, saveData } = require('../services/dataStore');
const { verifyPassword, shouldRehashPassword, hashPassword } = require('../lib/password');
const { createToken } = require('../lib/jwt');
const { logAudit } = require('../services/auditService');
const {
	authMiddleware, loginRateLimitMiddleware,
	setAuthCookieExpress, clearAuthCookieExpress,
	resetLoginRateLimit
} = require('../middleware/auth');

router.post('/login', loginRateLimitMiddleware, (req, res) => {
	const db = getDb();
	const { username, email, password } = req.body || {};
	if (!Array.isArray(db.users) || db.users.length === 0) {
		return res.status(503).json({ error: 'No users configured. Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD, then restart.' });
	}
	const loginName = String(username || email || '').trim().toLowerCase();
	const user = db.users.find(u => (u.username === loginName || u.email === loginName));
	if (!user || !verifyPassword(password, user.passwordHash)) return res.status(401).json({ error: 'Invalid credentials' });
	if (shouldRehashPassword(user.passwordHash)) {
		user.passwordHash = hashPassword(password);
		saveData();
	}
	resetLoginRateLimit(req.loginRateLimitKey);
	const token = createToken({ id: user.id, username: user.username, role: user.role });
	setAuthCookieExpress(req, res, token);
	logAudit(user, 'auth.login', {});
	res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

router.get('/me', authMiddleware, (req, res) => { res.json(req.user); });

router.post('/logout', (req, res) => {
	clearAuthCookieExpress(req, res);
	res.status(204).end();
});

module.exports = router;
