'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const { saveData, nextId } = require('../../services/dataStore');
const { logAudit } = require('../../services/auditService');
const { requireEditor } = require('../../middleware/auth');

// List maintenances
router.get('/', (req, res) => {
	res.json((req.project.scheduledMaintenances || []).sort((a, b) => new Date(b.scheduledStart) - new Date(a.scheduledStart)));
});

// Create maintenance
router.post('/', requireEditor, (req, res) => {
	const p = req.project;
	const { title, message, scheduledStart, scheduledEnd, affectedComponents } = req.body;
	if (!title || !scheduledStart || !scheduledEnd) return res.status(400).json({ error: 'Title, start and end required' });
	if (!p.scheduledMaintenances) p.scheduledMaintenances = [];
	const maint = { id: nextId(), title, status: 'scheduled', message: message || '', scheduledStart, scheduledEnd, affectedComponents: affectedComponents || [], updates: [{ id: nextId(), status: 'scheduled', message: message || 'Scheduled maintenance', createdAt: new Date().toISOString() }], createdAt: new Date().toISOString() };
	p.scheduledMaintenances.push(maint);
	saveData();
	logAudit(req.user, 'maintenance.create', { projectId: p.id, maintenanceId: maint.id });
	res.status(201).json(maint);
});

// Update maintenance
router.put('/:id', requireEditor, (req, res) => {
	const p = req.project;
	const maint = (p.scheduledMaintenances || []).find(m => m.id === parseInt(req.params.id));
	if (!maint) return res.status(404).json({ error: 'Not found' });
	const { status, message } = req.body;
	if (status) {
		maint.status = status;
		maint.updates.push({ id: nextId(), status, message: message || `Status changed to ${status}`, createdAt: new Date().toISOString() });
		if (status === 'in_progress') { for (const cid of (maint.affectedComponents || [])) { const c = p.components.find(x => x.id === cid); if (c) c.status = 'under_maintenance'; } }
		if (status === 'completed') { for (const cid of (maint.affectedComponents || [])) { const c = p.components.find(x => x.id === cid); if (c) c.status = 'operational'; } }
	}
	Object.assign(maint, req.body, { id: maint.id, updates: maint.updates, createdAt: maint.createdAt });
	saveData();
	logAudit(req.user, 'maintenance.update', { projectId: p.id, maintenanceId: maint.id });
	res.json(maint);
});

// Delete maintenance
router.delete('/:id', requireEditor, (req, res) => {
	req.project.scheduledMaintenances = (req.project.scheduledMaintenances || []).filter(m => m.id !== parseInt(req.params.id));
	saveData();
	logAudit(req.user, 'maintenance.delete', { projectId: req.project.id, maintenanceId: parseInt(req.params.id) });
	res.json({ message: 'Deleted' });
});

module.exports = router;
