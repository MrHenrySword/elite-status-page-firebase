'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const { saveData, nextId } = require('../../services/dataStore');
const { logAudit } = require('../../services/auditService');
const { requireEditor } = require('../../middleware/auth');

// List incidents
router.get('/', (req, res) => {
	res.json(req.project.incidents.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// Create incident
router.post('/', requireEditor, (req, res) => {
	const p = req.project;
	const { title, status, impact, message, affectedComponents } = req.body;
	if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
	const incident = { id: nextId(), title, status: status || 'investigating', impact: impact || 'minor', affectedComponents: affectedComponents || [], updates: [{ id: nextId(), status: status || 'investigating', message, createdAt: new Date().toISOString() }], createdAt: new Date().toISOString(), resolvedAt: null };
	p.incidents.push(incident);
	if (affectedComponents && affectedComponents.length) {
		const impactMap = { none: 'operational', minor: 'degraded_performance', major: 'partial_outage', critical: 'major_outage' };
		for (const cid of affectedComponents) {
			const comp = p.components.find(c => c.id === cid);
			if (comp && incident.status !== 'resolved') comp.status = impactMap[impact] || 'degraded_performance';
		}
	}
	saveData();
	logAudit(req.user, 'incident.create', { projectId: p.id, incidentId: incident.id });
	res.status(201).json(incident);
});

// Add incident update
router.post('/:id/updates', requireEditor, (req, res) => {
	const p = req.project;
	const incident = p.incidents.find(i => i.id === parseInt(req.params.id));
	if (!incident) return res.status(404).json({ error: 'Not found' });
	const { status, message } = req.body;
	if (!message) return res.status(400).json({ error: 'Message required' });
	const update = { id: nextId(), status: status || incident.status, message, createdAt: new Date().toISOString() };
	incident.updates.push(update);
	incident.status = update.status;
	if (update.status === 'resolved') {
		incident.resolvedAt = new Date().toISOString();
		for (const cid of (incident.affectedComponents || [])) {
			const comp = p.components.find(c => c.id === cid);
			if (comp) {
				const otherActive = p.incidents.find(i => i.id !== incident.id && i.status !== 'resolved' && i.status !== 'postmortem' && (i.affectedComponents || []).includes(cid));
				if (!otherActive) comp.status = 'operational';
			}
		}
	}
	saveData();
	logAudit(req.user, 'incident.update', { projectId: p.id, incidentId: incident.id });
	res.json(incident);
});

// Delete incident
router.delete('/:id', requireEditor, (req, res) => {
	req.project.incidents = req.project.incidents.filter(i => i.id !== parseInt(req.params.id));
	saveData();
	logAudit(req.user, 'incident.delete', { projectId: req.project.id, incidentId: parseInt(req.params.id) });
	res.json({ message: 'Deleted' });
});

module.exports = router;
