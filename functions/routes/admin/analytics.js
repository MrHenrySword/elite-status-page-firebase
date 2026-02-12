'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const { aggregateProjectAnalytics } = require('../../services/analyticsService');
const { readAuditEntries, summarizeAuditAction } = require('../../services/auditService');

// Project stats
router.get('/stats', (req, res) => {
	const p = req.project;
	res.json({
		totalComponents: p.components.length,
		operationalComponents: p.components.filter(c => c.status === 'operational').length,
		activeIncidents: p.incidents.filter(i => i.status !== 'resolved' && i.status !== 'postmortem').length,
		scheduledMaintenances: (p.scheduledMaintenances || []).filter(m => m.status !== 'completed').length,
		totalSubscribers: p.subscribers.length
	});
});

// Analytics
router.get('/analytics', (req, res) => {
	const p = req.project;
	const windowDays = Math.max(7, Math.min(90, parseInt(req.query.days || '30', 10)));
	const data = aggregateProjectAnalytics(p, windowDays);
	const recentIncidents = (p.incidents || []).filter(i => new Date(i.createdAt).getTime() >= (Date.now() - 30 * 86400000)).length;
	res.json({
		projectId: p.id,
		windowDays: data.days,
		totalViews: data.totalViews,
		totalUniqueVisitors: data.totalUnique,
		subscribers: (p.subscribers || []).length,
		recentIncidents,
		googleAnalyticsTrackingId: (p.settings && p.settings.googleAnalyticsTrackingId) || '',
		daily: data.daily
	});
});

// Activity log
router.get('/activity', (req, res) => {
	const projectId = req.project.id;
	const limit = Math.max(10, Math.min(200, parseInt(req.query.limit || '50', 10)));
	const lines = readAuditEntries(limit * 5);
	const filtered = [];
	for (const entry of lines) {
		const metaProject = entry && entry.meta ? parseInt(entry.meta.projectId, 10) : null;
		if (metaProject !== projectId) continue;
		filtered.push({
			at: entry.at,
			action: entry.action,
			user: entry.user || null,
			summary: summarizeAuditAction(entry.action, entry.meta),
			meta: entry.meta || {}
		});
		if (filtered.length >= limit) break;
	}
	res.json({ projectId, items: filtered });
});

module.exports = router;
