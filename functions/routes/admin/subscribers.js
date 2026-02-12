'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb, saveData } = require('../../services/dataStore');
const { isValidEmail } = require('../../lib/helpers');
const { logAudit } = require('../../services/auditService');
const { requireEditor } = require('../../middleware/auth');

// List subscribers
router.get('/', (req, res) => {
	res.json(req.project.subscribers);
});

// Export subscribers (must be before :id route)
router.get('/export', (req, res) => {
	const format = String(req.query.format || 'csv').toLowerCase();
	const subs = (req.project.subscribers || []).filter(s => s && s.email);
	if (format === 'json') {
		const content = JSON.stringify(subs.map(s => ({ email: s.email, createdAt: s.createdAt })), null, 2);
		res.json({ format: 'json', count: subs.length, filename: 'subscribers.json', content });
	} else {
		const lines = ['email,subscribed_at'];
		for (const s of subs) lines.push(`"${(s.email || '').replace(/"/g, '""')}","${s.createdAt || ''}"`);
		res.json({ format: 'csv', count: subs.length, filename: 'subscribers.csv', content: lines.join('\n') });
	}
});

// Import subscribers
router.post('/import', requireEditor, (req, res) => {
	const db = getDb();
	const { emails, replaceExisting } = req.body || {};
	if (!Array.isArray(emails) || !emails.length) return res.status(400).json({ error: 'No emails provided' });
	const existingEmails = new Set((req.project.subscribers || []).map(s => (s.email || '').toLowerCase().trim()));
	if (replaceExisting) {
		req.project.subscribers = [];
		existingEmails.clear();
	}
	let imported = 0, skippedExisting = 0, skippedInvalid = 0;
	for (const raw of emails) {
		const email = String(raw || '').trim().toLowerCase();
		if (!email || !isValidEmail(email)) { skippedInvalid++; continue; }
		if (existingEmails.has(email)) { skippedExisting++; continue; }
		existingEmails.add(email);
		req.project.subscribers.push({ id: db.nextId++, email, createdAt: new Date().toISOString() });
		imported++;
	}
	saveData();
	logAudit(req.user, 'subscribers.import', { projectId: req.project.id, imported, skippedExisting, skippedInvalid });
	res.json({ imported, skippedExisting, skippedInvalid });
});

// Delete subscriber
router.delete('/:id', requireEditor, (req, res) => {
	req.project.subscribers = req.project.subscribers.filter(s => s.id !== parseInt(req.params.id));
	saveData();
	logAudit(req.user, 'subscriber.delete', { projectId: req.project.id, subscriberId: parseInt(req.params.id) });
	res.json({ message: 'Deleted' });
});

module.exports = router;
