'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const { saveData, nextId } = require('../../services/dataStore');
const { logAudit } = require('../../services/auditService');
const { requireEditor } = require('../../middleware/auth');

// GET all components for project
router.get('/', (req, res) => {
	res.json(req.project.components.sort((a, b) => a.order - b.order));
});

// Create component
router.post('/', requireEditor, (req, res) => {
	const p = req.project;
	const { name, description, status, parentId } = req.body;
	if (!name) return res.status(400).json({ error: 'Name required' });
	const pid = parentId || null;
	const siblings = p.components.filter(c => (c.parentId || null) === pid);
	const nextOrder = siblings.length ? Math.max(...siblings.map(c => c.order || 0)) + 1 : 0;
	const comp = { id: nextId(), parentId: pid, name, description: description || '', status: status || 'operational', view: req.body.view || 'list', order: nextOrder, showUptime: true, createdAt: new Date().toISOString() };
	p.components.push(comp);
	const days = {}; const now = Date.now();
	for (let i = 0; i < 90; i++) days[new Date(now - i * 86400000).toISOString().slice(0, 10)] = 'operational';
	if (!p.uptimeData) p.uptimeData = {};
	p.uptimeData[comp.id] = days;
	saveData();
	logAudit(req.user, 'component.create', { projectId: p.id, componentId: comp.id });
	res.status(201).json(comp);
});

// Update component
router.put('/:id', requireEditor, (req, res) => {
	const p = req.project;
	const comp = p.components.find(c => c.id === parseInt(req.params.id));
	if (!comp) return res.status(404).json({ error: 'Not found' });
	const oldStatus = comp.status;
	const incomingParent = ('parentId' in req.body) ? (req.body.parentId || null) : comp.parentId;
	const parentChanged = incomingParent !== (comp.parentId || null);
	Object.assign(comp, req.body, { id: comp.id, createdAt: comp.createdAt, parentId: incomingParent });
	if (parentChanged) {
		const siblings = p.components.filter(c => c.id !== comp.id && (c.parentId || null) === incomingParent);
		comp.order = siblings.length ? Math.max(...siblings.map(c => c.order || 0)) + 1 : 0;
	}
	if (comp.status !== oldStatus) {
		const today = new Date().toISOString().slice(0, 10);
		if (!p.uptimeData) p.uptimeData = {};
		if (!p.uptimeData[comp.id]) p.uptimeData[comp.id] = {};
		const sm = { operational: 'operational', degraded_performance: 'degraded_performance', partial_outage: 'degraded_performance', major_outage: 'major_outage', under_maintenance: 'operational' };
		p.uptimeData[comp.id][today] = sm[comp.status] || 'operational';
	}
	saveData();
	logAudit(req.user, 'component.update', { projectId: p.id, componentId: comp.id });
	res.json(comp);
});

// Reorder components
router.post('/reorder', requireEditor, (req, res) => {
	const p = req.project;
	const parentId = req.body.parentId || null;
	const orderedIds = Array.isArray(req.body.orderedIds) ? req.body.orderedIds.map(id => parseInt(id)) : [];
	const siblings = p.components.filter(c => (c.parentId || null) === parentId);
	if (!siblings.length || !orderedIds.length) return res.json({ ok: true });
	const siblingIds = new Set(siblings.map(c => c.id));
	const normalized = orderedIds.filter(id => siblingIds.has(id));
	for (const c of siblings) {
		if (!normalized.includes(c.id)) normalized.push(c.id);
	}
	normalized.forEach((id, idx) => {
		const comp = p.components.find(c => c.id === id);
		if (comp) comp.order = idx;
	});
	saveData();
	logAudit(req.user, 'component.reorder', { projectId: p.id, parentId });
	res.json({ ok: true });
});

// Delete component
router.delete('/:id', requireEditor, (req, res) => {
	const p = req.project; const id = parseInt(req.params.id);
	p.components = p.components.filter(c => c.id !== id);
	if (p.uptimeData) delete p.uptimeData[id];
	saveData();
	logAudit(req.user, 'component.delete', { projectId: p.id, componentId: id });
	res.json({ message: 'Deleted' });
});

module.exports = router;
