'use strict';

const express = require('express');
const router = express.Router();
const { GENERAL_RATE_LIMIT_WINDOW_MS } = require('../lib/constants');
const {
	getDb, computeOverallStatus, getPublicProjectSettings,
	getPublicProjectSnapshot, getProjectDomainConfig,
	resolveProjectByHost, nextId, saveData
} = require('../services/dataStore');
const { slugMiddleware } = require('../middleware/projectResolver');

// Simple IP-based rate limit for public subscribe endpoint
const subscribeBuckets = new Map();
function subscribeRateLimit(req, res, next) {
	const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
	const now = Date.now();
	const bucket = subscribeBuckets.get(ip);
	if (bucket && now - bucket.start < GENERAL_RATE_LIMIT_WINDOW_MS) {
		if (bucket.count >= 5) return res.status(429).json({ error: 'Too many requests, please try again later' });
		bucket.count++;
	} else {
		subscribeBuckets.set(ip, { start: now, count: 1 });
	}
	next();
}

// List all projects (public, for project picker)
router.get('/projects', (_req, res) => {
	const db = getDb();
	res.setHeader('Cache-Control', 'public,max-age=60,stale-while-revalidate=120');
	res.json(db.projects.map(p => ({ id: p.id, name: p.name, slug: p.slug })));
});

// Resolve current project by host header (for custom domain publishing)
router.get('/project-context', (req, res) => {
	const db = getDb();
	const hostMatch = resolveProjectByHost(req.headers.host);
	const project = hostMatch ? hostMatch.project : db.projects[0];
	if (!project) return res.status(404).json({ error: 'No projects found' });
	const cfg = getProjectDomainConfig(project);
	res.json({
		id: project.id,
		name: project.name,
		slug: project.slug,
		customDomain: cfg.primaryDomain,
		redirectDomains: cfg.redirectDomains,
		source: hostMatch ? 'host' : 'default'
	});
});

router.get('/projects/:slug/status', slugMiddleware, (req, res) => {
	res.json({ status: computeOverallStatus(req.project.components), updatedAt: new Date().toISOString() });
});

router.get('/projects/:slug/components', slugMiddleware, (req, res) => {
	const p = req.project;
	const settings = p.settings || {};
	const mode = settings.displayMode || 'single';
	const db = getDb();

	if (mode === 'dual' || mode === 'triad') {
		const sources = [];
		sources.push({
			role: 'primary',
			projectId: p.id,
			projectName: settings.pageName || settings.pageTitle || p.name,
			componentsView: settings.componentsView || 'list',
			components: (p.components || []).sort((a, b) => (a.order || 0) - (b.order || 0))
		});
		const secondaryId = settings.secondaryProjectId ? parseInt(settings.secondaryProjectId, 10) : null;
		if (secondaryId) {
			const sp = db.projects.find(pr => pr.id === secondaryId);
			if (sp) {
				sources.push({
					role: 'secondary',
					projectId: sp.id,
					projectName: (sp.settings || {}).pageName || (sp.settings || {}).pageTitle || sp.name,
					componentsView: (sp.settings || {}).componentsView || 'list',
					components: (sp.components || []).sort((a, b) => (a.order || 0) - (b.order || 0))
				});
			}
		}
		if (mode === 'triad') {
			const tertiaryId = settings.tertiaryProjectId ? parseInt(settings.tertiaryProjectId, 10) : null;
			if (tertiaryId) {
				const tp = db.projects.find(pr => pr.id === tertiaryId);
				if (tp) {
					sources.push({
						role: 'tertiary',
						projectId: tp.id,
						projectName: (tp.settings || {}).pageName || (tp.settings || {}).pageTitle || tp.name,
						componentsView: (tp.settings || {}).componentsView || 'list',
						components: (tp.components || []).sort((a, b) => (a.order || 0) - (b.order || 0))
					});
				}
			}
		}
		return res.json({ sources });
	}

	res.json({ components: (p.components || []).sort((a, b) => (a.order || 0) - (b.order || 0)) });
});

router.get('/projects/:slug/incidents', slugMiddleware, (req, res) => {
	const { status, days } = req.query;
	let list = [...req.project.incidents].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
	if (status === 'active') list = list.filter(i => i.status !== 'resolved' && i.status !== 'postmortem');
	if (days) { const cutoff = Date.now() - parseInt(days) * 86400000; list = list.filter(i => new Date(i.createdAt).getTime() > cutoff); }
	res.json(list);
});

router.get('/projects/:slug/incidents/:id', slugMiddleware, (req, res) => {
	const inc = req.project.incidents.find(i => i.id === parseInt(req.params.id));
	if (!inc) return res.status(404).json({ error: 'Not found' });
	res.json(inc);
});

router.get('/projects/:slug/scheduled-maintenances', slugMiddleware, (req, res) => {
	const now = new Date();
	const list = (req.project.scheduledMaintenances || [])
		.filter(m => new Date(m.scheduledEnd) > now || m.status !== 'completed')
		.sort((a, b) => new Date(a.scheduledStart) - new Date(b.scheduledStart));
	res.json(list);
});

router.get('/projects/:slug/uptime', slugMiddleware, (req, res) => {
	res.json(req.project.uptimeData || {});
});

router.get('/projects/:slug/settings', slugMiddleware, (req, res) => {
	res.json(getPublicProjectSettings(req.project));
});

router.get('/projects/:slug/public-snapshot', slugMiddleware, (req, res) => {
	res.setHeader('Cache-Control', 'public,max-age=15,stale-while-revalidate=30');
	res.json(getPublicProjectSnapshot(req.project));
});

router.post('/projects/:slug/subscribers', slugMiddleware, subscribeRateLimit, (req, res) => {
	const p = req.project;
	const { email, webhook } = req.body || {};
	if (!email && !webhook) return res.status(400).json({ error: 'Email or webhook URL required' });
	if (email && p.subscribers.find(s => s.email === email)) return res.status(409).json({ error: 'Already subscribed' });
	p.subscribers.push({ id: nextId(), email: email || null, webhook: webhook || null, confirmed: true, createdAt: new Date().toISOString() });
	saveData();
	res.status(201).json({ message: 'Subscribed successfully' });
});

module.exports = router;
