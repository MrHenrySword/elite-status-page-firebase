'use strict';

const express = require('express');
const router = express.Router();
const { getDb, saveData, nextId } = require('../../services/dataStore');
const { hashPassword } = require('../../lib/password');
const { logAudit } = require('../../services/auditService');
const { authMiddleware, requireAdmin } = require('../../middleware/auth');

router.get('/', authMiddleware, requireAdmin, (_req, res) => {
	const db = getDb();
	res.json(db.users.map(u => ({ id: u.id, username: u.username, email: u.email || u.username, name: u.name || '', role: u.role, createdAt: u.createdAt })));
});

router.post('/', authMiddleware, requireAdmin, (req, res) => {
	const db = getDb();
	const { name, email, password, role } = req.body || {};
	if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
	if (!password || password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters' });
	const username = email.toLowerCase();
	if (db.users.find(u => u.username === username || u.email === username)) return res.status(409).json({ error: 'User already exists' });
	const user = { id: nextId(), username, email: username, name: name || '', passwordHash: hashPassword(password), role: role || 'admin', createdAt: new Date().toISOString() };
	db.users.push(user);
	saveData();
	logAudit(req.user, 'user.create', { userId: user.id, email: user.email, role: user.role });
	res.status(201).json({ id: user.id, username: user.username, email: user.email, name: user.name || '', role: user.role, createdAt: user.createdAt });
});

router.put('/:id', authMiddleware, requireAdmin, (req, res) => {
	const db = getDb();
	const user = db.users.find(u => u.id === parseInt(req.params.id));
	if (!user) return res.status(404).json({ error: 'Not found' });
	const { name, email, password, role } = req.body || {};
	if (email) {
		if (!email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
		const username = email.toLowerCase();
		if (db.users.find(u => (u.username === username || u.email === username) && u.id !== user.id)) return res.status(409).json({ error: 'Email already in use' });
		user.username = username;
		user.email = username;
	}
	if (name !== undefined) user.name = name;
	if (role) user.role = role;
	if (password) {
		if (password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters' });
		user.passwordHash = hashPassword(password);
	}
	saveData();
	logAudit(req.user, 'user.update', { userId: user.id });
	res.json({ id: user.id, username: user.username, email: user.email, name: user.name || '', role: user.role, createdAt: user.createdAt });
});

router.delete('/:id', authMiddleware, requireAdmin, (req, res) => {
	const db = getDb();
	const id = parseInt(req.params.id);
	if (req.user.id === id) return res.status(400).json({ error: 'Cannot delete self' });
	const target = db.users.find(u => u.id === id);
	if (!target) return res.status(404).json({ error: 'Not found' });
	const admins = db.users.filter(u => u.role === 'admin');
	if (target.role === 'admin' && admins.length <= 1) return res.status(400).json({ error: 'Cannot delete last admin' });
	db.users = db.users.filter(u => u.id !== id);
	saveData();
	logAudit(req.user, 'user.delete', { userId: id });
	res.json({ message: 'Deleted' });
});

module.exports = router;
