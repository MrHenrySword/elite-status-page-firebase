'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb, saveData } = require('../../services/dataStore');
const { logAudit } = require('../../services/auditService');
const { requireEditor } = require('../../middleware/auth');

// ── Incident Templates ──────────────────────────────────────────────────

router.get('/incident-templates', (req, res) => {
	res.json(req.project.incidentTemplates || []);
});

router.post('/incident-templates', requireEditor, (req, res) => {
	const db = getDb();
	const { name, title, status, impact, message, affectedComponents } = req.body || {};
	const fieldErrors = {};
	if (!name || !String(name).trim()) fieldErrors.name = 'Template name is required';
	if (!title || !String(title).trim()) fieldErrors.title = 'Incident title is required';
	if (!message || !String(message).trim()) fieldErrors.message = 'Default message is required';
	if (Object.keys(fieldErrors).length) return res.status(400).json({ error: 'Validation failed', fieldErrors });
	if (!req.project.incidentTemplates) req.project.incidentTemplates = [];
	const template = {
		id: db.nextId++,
		name: String(name).trim(),
		title: String(title).trim(),
		status: status || 'investigating',
		impact: impact || 'minor',
		message: String(message).trim(),
		affectedComponents: Array.isArray(affectedComponents) ? affectedComponents.map(Number) : [],
		createdAt: new Date().toISOString()
	};
	req.project.incidentTemplates.push(template);
	saveData();
	logAudit(req.user, 'incident-template.create', { projectId: req.project.id, templateId: template.id });
	res.status(201).json(template);
});

router.put('/incident-templates/:id', requireEditor, (req, res) => {
	if (!req.project.incidentTemplates) req.project.incidentTemplates = [];
	const template = req.project.incidentTemplates.find(t => t.id === parseInt(req.params.id));
	if (!template) return res.status(404).json({ error: 'Template not found' });
	const { name, title, status, impact, message, affectedComponents } = req.body || {};
	const fieldErrors = {};
	if (Object.prototype.hasOwnProperty.call(req.body, 'name') && !String(name || '').trim()) fieldErrors.name = 'Template name is required';
	if (Object.prototype.hasOwnProperty.call(req.body, 'title') && !String(title || '').trim()) fieldErrors.title = 'Incident title is required';
	if (Object.prototype.hasOwnProperty.call(req.body, 'message') && !String(message || '').trim()) fieldErrors.message = 'Default message is required';
	if (Object.keys(fieldErrors).length) return res.status(400).json({ error: 'Validation failed', fieldErrors });
	if (name !== undefined) template.name = String(name).trim();
	if (title !== undefined) template.title = String(title).trim();
	if (status !== undefined) template.status = status;
	if (impact !== undefined) template.impact = impact;
	if (message !== undefined) template.message = String(message).trim();
	if (affectedComponents !== undefined) template.affectedComponents = Array.isArray(affectedComponents) ? affectedComponents.map(Number) : [];
	template.updatedAt = new Date().toISOString();
	saveData();
	logAudit(req.user, 'incident-template.update', { projectId: req.project.id, templateId: template.id });
	res.json(template);
});

router.delete('/incident-templates/:id', requireEditor, (req, res) => {
	if (!req.project.incidentTemplates) req.project.incidentTemplates = [];
	req.project.incidentTemplates = req.project.incidentTemplates.filter(t => t.id !== parseInt(req.params.id));
	saveData();
	logAudit(req.user, 'incident-template.delete', { projectId: req.project.id, templateId: parseInt(req.params.id) });
	res.json({ message: 'Deleted' });
});

// ── Maintenance Templates ───────────────────────────────────────────────

router.get('/maintenance-templates', (req, res) => {
	res.json(req.project.maintenanceTemplates || []);
});

router.post('/maintenance-templates', requireEditor, (req, res) => {
	const db = getDb();
	const { name, title, message, defaultDurationMinutes, affectedComponents } = req.body || {};
	const fieldErrors = {};
	if (!name || !String(name).trim()) fieldErrors.name = 'Template name is required';
	if (!title || !String(title).trim()) fieldErrors.title = 'Maintenance title is required';
	const duration = parseInt(defaultDurationMinutes, 10);
	if (!Number.isInteger(duration) || duration < 5 || duration > 10080) fieldErrors.defaultDurationMinutes = 'Duration must be between 5 and 10080 minutes';
	if (Object.keys(fieldErrors).length) return res.status(400).json({ error: 'Validation failed', fieldErrors });
	if (!req.project.maintenanceTemplates) req.project.maintenanceTemplates = [];
	const template = {
		id: db.nextId++,
		name: String(name).trim(),
		title: String(title).trim(),
		message: String(message || '').trim(),
		defaultDurationMinutes: duration,
		affectedComponents: Array.isArray(affectedComponents) ? affectedComponents.map(Number) : [],
		createdAt: new Date().toISOString()
	};
	req.project.maintenanceTemplates.push(template);
	saveData();
	logAudit(req.user, 'maintenance-template.create', { projectId: req.project.id, templateId: template.id });
	res.status(201).json(template);
});

router.put('/maintenance-templates/:id', requireEditor, (req, res) => {
	if (!req.project.maintenanceTemplates) req.project.maintenanceTemplates = [];
	const template = req.project.maintenanceTemplates.find(t => t.id === parseInt(req.params.id));
	if (!template) return res.status(404).json({ error: 'Template not found' });
	const { name, title, message, defaultDurationMinutes, affectedComponents } = req.body || {};
	const fieldErrors = {};
	if (Object.prototype.hasOwnProperty.call(req.body, 'name') && !String(name || '').trim()) fieldErrors.name = 'Template name is required';
	if (Object.prototype.hasOwnProperty.call(req.body, 'title') && !String(title || '').trim()) fieldErrors.title = 'Maintenance title is required';
	if (Object.prototype.hasOwnProperty.call(req.body, 'defaultDurationMinutes')) {
		const dur = parseInt(defaultDurationMinutes, 10);
		if (!Number.isInteger(dur) || dur < 5 || dur > 10080) fieldErrors.defaultDurationMinutes = 'Duration must be between 5 and 10080 minutes';
	}
	if (Object.keys(fieldErrors).length) return res.status(400).json({ error: 'Validation failed', fieldErrors });
	if (name !== undefined) template.name = String(name).trim();
	if (title !== undefined) template.title = String(title).trim();
	if (message !== undefined) template.message = String(message || '').trim();
	if (defaultDurationMinutes !== undefined) template.defaultDurationMinutes = parseInt(defaultDurationMinutes, 10);
	if (affectedComponents !== undefined) template.affectedComponents = Array.isArray(affectedComponents) ? affectedComponents.map(Number) : [];
	template.updatedAt = new Date().toISOString();
	saveData();
	logAudit(req.user, 'maintenance-template.update', { projectId: req.project.id, templateId: template.id });
	res.json(template);
});

router.delete('/maintenance-templates/:id', requireEditor, (req, res) => {
	if (!req.project.maintenanceTemplates) req.project.maintenanceTemplates = [];
	req.project.maintenanceTemplates = req.project.maintenanceTemplates.filter(t => t.id !== parseInt(req.params.id));
	saveData();
	logAudit(req.user, 'maintenance-template.delete', { projectId: req.project.id, templateId: parseInt(req.params.id) });
	res.json({ message: 'Deleted' });
});

module.exports = router;
