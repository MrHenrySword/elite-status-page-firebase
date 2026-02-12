'use strict';

const fs = require('fs');
const { LOG_FILE } = require('../lib/constants');

function logAudit(user, action, meta) {
	try {
		const entry = {
			at: new Date().toISOString(),
			user: user ? { id: user.id, username: user.username, role: user.role } : null,
			action,
			meta: meta || {}
		};
		fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
	} catch (e) { /* ignore logging errors */ }
}

function readAuditEntries(limit = 50) {
	try {
		if (!fs.existsSync(LOG_FILE)) return [];
		const raw = fs.readFileSync(LOG_FILE, 'utf-8');
		const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
		const parsed = [];
		for (let i = lines.length - 1; i >= 0 && parsed.length < limit; i--) {
			try { parsed.push(JSON.parse(lines[i])); } catch { /* ignore bad line */ }
		}
		return parsed;
	} catch {
		return [];
	}
}

function summarizeAuditAction(action, meta) {
	const m = meta || {};
	if (action === 'settings.update') {
		const fields = Array.isArray(m.fields) ? m.fields.filter(Boolean) : [];
		if (fields.length) return `Updated settings (${fields.slice(0, 4).join(', ')}${fields.length > 4 ? ', ...' : ''})`;
		return 'Updated project settings';
	}
	const map = {
		'project.create': `Created project "${m.name || ''}"`,
		'project.update': 'Updated project details',
		'project.delete': 'Deleted project',
		'component.create': 'Created component',
		'component.update': 'Updated component',
		'component.reorder': 'Reordered components',
		'component.delete': 'Deleted component',
		'incident.create': 'Created incident',
		'incident.update': 'Updated incident',
		'incident.delete': 'Deleted incident',
		'maintenance.create': 'Created scheduled maintenance',
		'maintenance.update': 'Updated scheduled maintenance',
		'maintenance.delete': 'Deleted scheduled maintenance',
		'subscriber.delete': 'Removed subscriber',
		'user.create': 'Created user',
		'user.update': 'Updated user',
		'user.delete': 'Deleted user',
		'auth.login': 'Logged in'
	};
	return map[action] || action;
}

module.exports = { logAudit, readAuditEntries, summarizeAuditAction };
