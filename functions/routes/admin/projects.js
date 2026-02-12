'use strict';

const express = require('express');
const router = express.Router();
const { getDb, saveData, nextId, getProjectDomainConfig } = require('../../services/dataStore');
const { makeSlug } = require('../../lib/helpers');
const { logAudit } = require('../../services/auditService');
const { authMiddleware, requireEditor } = require('../../middleware/auth');
const { projectMiddleware } = require('../../middleware/projectResolver');

// List all projects
router.get('/', authMiddleware, (_req, res) => {
	const db = getDb();
	res.json(db.projects.map(p => {
		const cfg = getProjectDomainConfig(p);
		return { id: p.id, name: p.name, slug: p.slug, customDomain: cfg.primaryDomain, createdAt: p.createdAt };
	}));
});

// Create project
router.post('/', authMiddleware, requireEditor, (req, res) => {
	const db = getDb();
	const { name } = req.body;
	if (!name) return res.status(400).json({ error: 'Name required' });
	let slug = makeSlug(name);
	if (db.projects.find(p => p.slug === slug)) slug = slug + '-' + Date.now();
	const id = nextId();
	const proj = {
		id, name, slug,
		settings: {
			pageTitle: name + ' Status',
			pageName: name + ' Status',
			organizationLegalName: name,
			companyName: name,
			companyUrl: '',
			supportUrl: '',
			privacyPolicyUrl: '',
			supportEmail: 'support@example.com',
			notificationFromName: name,
			notificationFromEmail: 'support@example.com',
			notificationReplyToEmail: 'support@example.com',
			notificationFooterMessage: `You received this email because you are subscribed to ${name} status notifications.`,
			notificationLogoUrl: '',
			notificationUseStatusLogo: true,
			defaultSmsCountryCode: '+1',
			timezone: 'UTC',
			googleAnalyticsTrackingId: '',
			hideFromSearchEngines: false,
			brandColor: '#0052cc',
			aboutText: 'Welcome to the status page. Here you can find live updates and incident history.',
			componentsView: 'list',
			showUptime: true,
			disabledTabs: {},
			customDomain: '',
			redirectDomains: [],
			createdAt: new Date().toISOString()
		},
		componentGroups: [], components: [], incidents: [], scheduledMaintenances: [], subscribers: [], uptimeData: {},
		analytics: { pageViewsByDay: {}, uniqueVisitorsByDay: {}, visitorHashesByDay: {}, updatedAt: new Date().toISOString() },
		createdAt: new Date().toISOString()
	};
	db.projects.push(proj);
	saveData();
	logAudit(req.user, 'project.create', { projectId: proj.id, name: proj.name, slug: proj.slug });
	res.status(201).json({ id: proj.id, name: proj.name, slug: proj.slug });
});

// Update project
router.put('/:projectId', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
	const db = getDb();
	const p = req.project;
	if (req.body.name) p.name = req.body.name;
	if (req.body.slug) {
		const newSlug = makeSlug(req.body.slug);
		if (db.projects.find(x => x.slug === newSlug && x.id !== p.id)) return res.status(409).json({ error: 'Slug already in use' });
		p.slug = newSlug;
	}
	saveData();
	logAudit(req.user, 'project.update', { projectId: p.id });
	res.json({ id: p.id, name: p.name, slug: p.slug });
});

// Delete project
router.delete('/:projectId', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
	const db = getDb();
	db.projects = db.projects.filter(p => p.id !== req.project.id);
	saveData();
	logAudit(req.user, 'project.delete', { projectId: req.project.id });
	res.json({ message: 'Deleted' });
});

module.exports = router;
