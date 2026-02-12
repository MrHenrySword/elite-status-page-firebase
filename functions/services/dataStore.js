'use strict';

const fs = require('fs');
const { DATA_FILE } = require('../lib/constants');
const {
	normalizeDomain, normalizeDomainList, isValidDomainHost, sanitizeDisabledTabs
} = require('../lib/helpers');
const { ensureInitialUsers, migrateLegacyPasswordHashes, buildInitialUsers } = require('../lib/password');

let db;

// ── Default data models ─────────────────────────────────────────────────

function defaultProject(id, name, slug) {
	return {
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
			statusPageLogoUrl: '',
			adminPanelLogoUrl: '',
			displayMode: 'single',
			secondaryProjectId: null,
			tertiaryProjectId: null,
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
			domainAutomationProvider: 'firebase_hosting',
			domainRegistrar: '',
			dnsProvider: '',
			domainContactEmail: '',
			dnsProviderAccountId: '',
			dnsProviderZone: '',
			createdAt: new Date().toISOString()
		},
		components: [
			{ id: id * 1000 + 10, parentId: null, name: 'USA', description: 'United States region', status: 'operational', order: 0, showUptime: true, view: 'list', createdAt: new Date().toISOString() },
			{ id: id * 1000 + 11, parentId: id * 1000 + 10, name: '3E LIVE USA', description: '3E Cloud Live - USA', status: 'operational', order: 0, showUptime: true, view: 'list', createdAt: new Date().toISOString() },
			{ id: id * 1000 + 12, parentId: id * 1000 + 10, name: '3E PREVIEW USA', description: '3E Cloud Preview - USA', status: 'operational', order: 1, showUptime: true, view: 'list', createdAt: new Date().toISOString() },
			{ id: id * 1000 + 13, parentId: null, name: 'CANADA', description: 'Canada region', status: 'operational', order: 1, showUptime: true, view: 'list', createdAt: new Date().toISOString() },
			{ id: id * 1000 + 14, parentId: id * 1000 + 13, name: '3E LIVE CANADA', description: '3E Cloud Live - Canada', status: 'operational', order: 0, showUptime: true, view: 'list', createdAt: new Date().toISOString() },
			{ id: id * 1000 + 15, parentId: id * 1000 + 13, name: '3E PREVIEW CANADA', description: '3E Cloud Preview - Canada', status: 'operational', order: 1, showUptime: true, view: 'list', createdAt: new Date().toISOString() },
			{ id: id * 1000 + 16, parentId: null, name: 'UK', description: 'United Kingdom region', status: 'operational', order: 2, showUptime: true, view: 'list', createdAt: new Date().toISOString() },
			{ id: id * 1000 + 17, parentId: id * 1000 + 16, name: '3E LIVE UK', description: '3E Cloud Live - UK', status: 'operational', order: 0, showUptime: true, view: 'list', createdAt: new Date().toISOString() },
			{ id: id * 1000 + 18, parentId: id * 1000 + 16, name: '3E PREVIEW UK', description: '3E Cloud Preview - UK', status: 'operational', order: 1, showUptime: true, view: 'list', createdAt: new Date().toISOString() },
			{ id: id * 1000 + 19, parentId: null, name: 'EUROPE', description: 'Europe region', status: 'operational', order: 3, showUptime: true, view: 'list', createdAt: new Date().toISOString() },
			{ id: id * 1000 + 20, parentId: null, name: 'AUSTRALIA', description: 'Australia region', status: 'operational', order: 4, showUptime: true, view: 'list', createdAt: new Date().toISOString() }
		],
		incidents: [],
		scheduledMaintenances: [],
		incidentTemplates: [
			{ id: id * 1000 + 100, name: 'Service Outage', title: 'Service Outage \u2014 [Region/Component]', status: 'investigating', impact: 'major', message: 'We are currently investigating reports of service disruption. Our engineering team has been alerted and is actively working to identify the root cause. We will provide an update within 30 minutes.', affectedComponents: [], createdAt: new Date().toISOString() },
			{ id: id * 1000 + 101, name: 'Degraded Performance', title: 'Degraded Performance \u2014 [Region/Component]', status: 'investigating', impact: 'minor', message: 'We are aware of degraded performance affecting some users. Our team is investigating the issue and working to restore normal service levels. Updates will follow as we learn more.', affectedComponents: [], createdAt: new Date().toISOString() },
			{ id: id * 1000 + 102, name: 'Partial Outage', title: 'Partial Outage \u2014 [Region/Component]', status: 'investigating', impact: 'major', message: 'A partial service outage has been detected affecting a subset of users. Our engineering team is actively working on mitigation. We expect to provide the next update within 30 minutes.', affectedComponents: [], createdAt: new Date().toISOString() },
			{ id: id * 1000 + 103, name: 'Security Incident', title: 'Security Incident \u2014 Investigation in Progress', status: 'investigating', impact: 'critical', message: 'We have identified a security-related event and our security operations team is actively investigating. As a precaution, additional protective measures have been enabled. We will provide updates as more information becomes available.', affectedComponents: [], createdAt: new Date().toISOString() },
			{ id: id * 1000 + 104, name: 'DNS / Network Issue', title: 'DNS / Network Connectivity Issue', status: 'investigating', impact: 'major', message: 'We are investigating reports of intermittent connectivity issues. This may affect access to some services. Our network team is working to identify and resolve the issue.', affectedComponents: [], createdAt: new Date().toISOString() },
			{ id: id * 1000 + 105, name: 'Third-Party Provider Issue', title: 'Third-Party Provider Disruption \u2014 [Provider Name]', status: 'identified', impact: 'minor', message: 'We have identified that a third-party provider is experiencing issues that may impact our service. We are monitoring the situation closely and will provide updates as their status evolves.', affectedComponents: [], createdAt: new Date().toISOString() }
		],
		maintenanceTemplates: [
			{ id: id * 1000 + 200, name: 'Scheduled Upgrade', title: 'Scheduled Upgrade \u2014 [Version] [Region]', message: 'A scheduled upgrade will be performed during the maintenance window. Users may experience brief interruptions as systems are updated. No action is required from your end.', defaultDurationMinutes: 180, affectedComponents: [], createdAt: new Date().toISOString() },
			{ id: id * 1000 + 201, name: 'Infrastructure Maintenance', title: 'Infrastructure Maintenance \u2014 [Description]', message: 'Routine infrastructure maintenance is scheduled. There may be brief service interruptions during this period. We will update this notice once maintenance is complete.', defaultDurationMinutes: 120, affectedComponents: [], createdAt: new Date().toISOString() },
			{ id: id * 1000 + 202, name: 'Database Maintenance', title: 'Database Maintenance Window', message: 'Scheduled database maintenance will be performed. Users may experience read-only access or brief downtime during this window. Please save your work before the maintenance begins.', defaultDurationMinutes: 60, affectedComponents: [], createdAt: new Date().toISOString() },
			{ id: id * 1000 + 203, name: 'Security Patch', title: 'Security Patch Deployment \u2014 [Region]', message: 'A critical security patch will be deployed. While the update is designed to be non-disruptive, brief service interruptions may occur. This update is necessary to maintain our security standards.', defaultDurationMinutes: 60, affectedComponents: [], createdAt: new Date().toISOString() },
			{ id: id * 1000 + 204, name: 'Network Maintenance', title: 'Network Maintenance \u2014 [Region/Description]', message: 'Routine network maintenance is scheduled. Connectivity may be intermittent during the maintenance window. We recommend scheduling critical operations outside this period.', defaultDurationMinutes: 90, affectedComponents: [], createdAt: new Date().toISOString() }
		],
		subscribers: [],
		uptimeData: {},
		analytics: { pageViewsByDay: {}, uniqueVisitorsByDay: {}, visitorHashesByDay: {}, updatedAt: new Date().toISOString() },
		createdAt: new Date().toISOString()
	};
}

function defaultData() {
	const eliteProject = defaultProject(1, '3E Elite', 'default');
	eliteProject.settings.displayMode = 'triad';
	eliteProject.settings.secondaryProjectId = 2;
	eliteProject.settings.tertiaryProjectId = 3;
	eliteProject.settings.brandColor = '#8738ff';
	eliteProject.settings.aboutText = 'NOTE: If you have been redirected to this page from another 3E application, please refer below to see the current status.\n\nWelcome to the 3E Statuspage. This page provides the current statuses of 3E Cloud systems globally. Please note the statuses of your specific region below.\n\nThis page also provides notifications for \'Incidents\' and \'Scheduled Maintenance\' for both LIVE and PREVIEW. Please refer to those sections below for the latest notices. Notices specific to a particular region will be noted in the title (ex. USA, CAN, UK, EU, AUS and the like). If not noted, it applies globally.\n\nADDITIONAL INFORMATION:\n\nPlease refer to the following Knowledge Base (KB) articles. To access the KB, go to https://customerportal.elite.com/ and select the \'Knowledge Base\' option. If you haven\'t done so already, please also subscribe to these articles to receive immediate notifications when updates are published.\n\nE-20507 3E Cloud \u2013 Statuspage Guide (explains what the 3E Cloud Statuspage is and how you can use it)\nE-6446 3E Cloud (SaaS) \u2013 Release Schedule (with release note references)\nE-18382 3E Cloud / E-18383 3E Cloud CARE \u2013 Upgrade Guidelines (regarding upgrades, updates, and hot fixes)\nE-17852 3E Cloud \u2013 Upgrade Preparation and Tasks (with recommended upgrade tasks at the cloud-component level)';

	const ebillinghubProject = defaultProject(2, 'ebillinghub', 'ebillinghub');
	ebillinghubProject.components = [
		{ id: 2010, parentId: null, name: 'EbillingHub Components', description: 'EbillingHub system', status: 'operational', order: 0, showUptime: true, view: 'list', createdAt: new Date().toISOString() }
	];

	const paymentsProject = defaultProject(3, 'Elite Payments', 'elite-payments');
	paymentsProject.components = [
		{ id: 3010, parentId: null, name: 'Submission API', description: 'Payment submission endpoint', status: 'operational', order: 0, showUptime: true, view: 'list', createdAt: new Date().toISOString() },
		{ id: 3011, parentId: 3010, name: 'Payment Gateway', description: 'Payment processing gateway', status: 'operational', order: 0, showUptime: true, view: 'list', createdAt: new Date().toISOString() }
	];

	return {
		users: buildInitialUsers(),
		projects: [eliteProject, ebillinghubProject, paymentsProject],
		nextId: 4000
	};
}

// ── Data loading / saving ───────────────────────────────────────────────

function loadData() {
	try {
		if (fs.existsSync(DATA_FILE)) {
			const raw = fs.readFileSync(DATA_FILE, 'utf-8');
			const d = JSON.parse(raw);
			if (!d.projects) d.projects = [];
			if (!d.users) d.users = [];
			if (!d.nextId) d.nextId = 2000;
			ensureInitialUsers(d);
			// Migrate old flat format → project
			if (d.components && !d.projects.length) {
				const proj = { id: 1, name: '3E Elite', slug: 'default', settings: d.settings || {}, componentGroups: d.componentGroups || [], components: d.components || [], incidents: d.incidents || [], scheduledMaintenances: d.scheduledMaintenances || [], subscribers: d.subscribers || [], uptimeData: d.uptimeData || {}, createdAt: new Date().toISOString() };
				d.projects = [proj];
				delete d.components; delete d.componentGroups; delete d.incidents; delete d.scheduledMaintenances; delete d.subscribers; delete d.uptimeData; delete d.settings;
			}
			// Ensure settings defaults for all projects
			for (const p of d.projects) {
				if (!p.settings) p.settings = {};
				if (!p.settings.pageTitle) p.settings.pageTitle = (p.name || 'Status') + ' Status';
				if (!p.settings.pageName) p.settings.pageName = p.settings.pageTitle;
				if (!p.settings.organizationLegalName) p.settings.organizationLegalName = p.name || '';
				if (!p.settings.companyName) p.settings.companyName = p.name || '';
				if (!p.settings.companyUrl) p.settings.companyUrl = '';
				if (!p.settings.supportUrl) p.settings.supportUrl = '';
				if (!p.settings.privacyPolicyUrl) p.settings.privacyPolicyUrl = '';
				if (!p.settings.supportEmail) p.settings.supportEmail = 'support@example.com';
				if (!p.settings.notificationFromName) p.settings.notificationFromName = p.settings.organizationLegalName || p.settings.companyName || p.name || '';
				if (!p.settings.notificationFromEmail) p.settings.notificationFromEmail = p.settings.supportEmail || 'support@example.com';
				if (!p.settings.notificationReplyToEmail) p.settings.notificationReplyToEmail = p.settings.supportEmail || 'support@example.com';
				if (!p.settings.notificationFooterMessage) p.settings.notificationFooterMessage = `You received this email because you are subscribed to ${(p.settings.pageName || p.settings.pageTitle || p.name || 'this service')} status notifications.`;
				if (!p.settings.notificationLogoUrl) p.settings.notificationLogoUrl = '';
				if (typeof p.settings.notificationUseStatusLogo !== 'boolean') p.settings.notificationUseStatusLogo = true;
				if (!p.settings.defaultSmsCountryCode) p.settings.defaultSmsCountryCode = '+1';
				if (!p.settings.timezone) p.settings.timezone = 'UTC';
				if (!p.settings.googleAnalyticsTrackingId) p.settings.googleAnalyticsTrackingId = '';
				if (typeof p.settings.hideFromSearchEngines !== 'boolean') p.settings.hideFromSearchEngines = false;
				if (!p.settings.brandColor) p.settings.brandColor = '#0052cc';
				if (!p.settings.aboutText) p.settings.aboutText = 'Welcome to the status page. Here you can find live updates and incident history.';
				if (!p.settings.componentsView) p.settings.componentsView = 'list';
				if (typeof p.settings.showUptime !== 'boolean') p.settings.showUptime = true;
				p.settings.disabledTabs = sanitizeDisabledTabs(p.settings.disabledTabs || {});
				p.settings.customDomain = normalizeDomain(p.settings.customDomain || '');
				if (p.settings.customDomain && !isValidDomainHost(p.settings.customDomain)) p.settings.customDomain = '';
				p.settings.redirectDomains = normalizeDomainList(p.settings.redirectDomains || []).filter(d => d !== p.settings.customDomain);
				p.settings.redirectDomains = p.settings.redirectDomains.filter(isValidDomainHost);
				if (!p.analytics || typeof p.analytics !== 'object') p.analytics = {};
				if (!p.analytics.pageViewsByDay || typeof p.analytics.pageViewsByDay !== 'object') p.analytics.pageViewsByDay = {};
				if (!p.analytics.uniqueVisitorsByDay || typeof p.analytics.uniqueVisitorsByDay !== 'object') p.analytics.uniqueVisitorsByDay = {};
				if (!p.analytics.visitorHashesByDay || typeof p.analytics.visitorHashesByDay !== 'object') p.analytics.visitorHashesByDay = {};
				if (!p.analytics.updatedAt) p.analytics.updatedAt = new Date().toISOString();
				if (Array.isArray(p.components)) {
					let fallbackOrder = 0;
					for (const c of p.components) {
						if (!('parentId' in c)) c.parentId = null;
						if (!c.view) c.view = 'list';
						if (typeof c.order !== 'number') c.order = fallbackOrder++;
					}
				}
			}
			const allowedRootKeys = new Set(['users', 'projects', 'nextId', 'securityMigrations']);
			for (const key of Object.keys(d)) {
				if (!allowedRootKeys.has(key)) delete d[key];
			}
			return d;
		}
	} catch (e) {
		console.error('[CRITICAL] Failed to parse data.json — starting with defaults. Error:', e.message);
		try {
			const backup = DATA_FILE + '.corrupt.' + Date.now();
			if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, backup);
			console.error('[CRITICAL] Corrupt file backed up to', backup);
		} catch (_) { /* best effort */ }
	}
	return defaultData();
}

function saveData() {
	try {
		const tmp = DATA_FILE + '.tmp';
		fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf-8');
		fs.renameSync(tmp, DATA_FILE);
	} catch (e) { console.error('Failed to save data:', e.message); }
}

// ── Seed uptime for all projects ────────────────────────────────────────

function seedUptime() {
	const now = Date.now();
	for (const proj of db.projects) {
		if (Object.keys(proj.uptimeData || {}).length > 0) continue;
		if (!proj.uptimeData) proj.uptimeData = {};
		for (const comp of proj.components) {
			const days = {};
			for (let i = 0; i < 90; i++) {
				const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
				const r = Math.random();
				days[d] = r > 0.97 ? 'major_outage' : r > 0.94 ? 'degraded_performance' : 'operational';
			}
			proj.uptimeData[comp.id] = days;
		}
	}
	saveData();
}

// ── Database initialization ─────────────────────────────────────────────

function initDb() {
	db = loadData();
	if (migrateLegacyPasswordHashes(db)) saveData();
	if (!Array.isArray(db.users) || db.users.length === 0) {
		console.warn('No admin users configured. Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD before first login.');
	}
	seedUptime();
}

// ── Accessors ───────────────────────────────────────────────────────────

function getDb() { return db; }
function nextId() { db.nextId = (db.nextId || 2000) + 1; return db.nextId; }
function getProjectBySlug(slug) { return db.projects.find(p => p.slug === slug); }
function getProjectById(id) { return db.projects.find(p => p.id === parseInt(id)); }

function computeOverallStatus(components) {
	let overall = 'operational';
	const list = Array.isArray(components) ? components : [];
	if (list.some(c => c.status === 'major_outage')) overall = 'major_outage';
	else if (list.some(c => c.status === 'partial_outage')) overall = 'partial_outage';
	else if (list.some(c => c.status === 'degraded_performance')) overall = 'degraded_performance';
	else if (list.some(c => c.status === 'under_maintenance')) overall = 'under_maintenance';
	return overall;
}

function getProjectDomainConfig(project) {
	const primaryDomain = normalizeDomain(project && project.settings ? project.settings.customDomain : '');
	const redirectDomains = normalizeDomainList(project && project.settings ? project.settings.redirectDomains : [])
		.filter(d => d !== primaryDomain);
	return { primaryDomain, redirectDomains };
}

function getPublicProjectSettings(project) {
	const settings = (project && project.settings && typeof project.settings === 'object') ? project.settings : {};
	return {
		pageTitle: settings.pageTitle || '',
		pageName: settings.pageName || '',
		organizationLegalName: settings.organizationLegalName || '',
		companyName: settings.companyName || '',
		companyUrl: settings.companyUrl || '',
		supportUrl: settings.supportUrl || '',
		privacyPolicyUrl: settings.privacyPolicyUrl || '',
		notificationFromName: settings.notificationFromName || '',
		notificationFromEmail: settings.notificationFromEmail || '',
		notificationReplyToEmail: settings.notificationReplyToEmail || '',
		notificationFooterMessage: settings.notificationFooterMessage || '',
		notificationLogoUrl: settings.notificationLogoUrl || '',
		notificationUseStatusLogo: settings.notificationUseStatusLogo !== false,
		defaultSmsCountryCode: settings.defaultSmsCountryCode || '+1',
		timezone: settings.timezone || 'UTC',
		googleAnalyticsTrackingId: settings.googleAnalyticsTrackingId || '',
		hideFromSearchEngines: !!settings.hideFromSearchEngines,
		brandColor: settings.brandColor || '#0052cc',
		aboutText: settings.aboutText || '',
		componentsView: settings.componentsView || 'list',
		showUptime: settings.showUptime !== false,
		disabledTabs: sanitizeDisabledTabs(settings.disabledTabs || {}),
		customDomain: normalizeDomain(settings.customDomain || ''),
		redirectDomains: normalizeDomainList(settings.redirectDomains || []),
		displayMode: settings.displayMode || 'single',
		secondaryProjectId: settings.secondaryProjectId || null,
		tertiaryProjectId: settings.tertiaryProjectId || null,
		statusPageLogoUrl: settings.statusPageLogoUrl || ''
	};
}

function getPublicProjectSnapshot(project) {
	const p = project || {};
	const settings = getPublicProjectSettings(p);
	const components = Array.isArray(p.components) ? [...p.components].sort((a, b) => (a.order || 0) - (b.order || 0)) : [];
	const incidents = Array.isArray(p.incidents)
		? [...p.incidents].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
		: [];
	const scheduledMaintenances = Array.isArray(p.scheduledMaintenances)
		? [...p.scheduledMaintenances].sort((a, b) => new Date(a.scheduledStart || 0) - new Date(b.scheduledStart || 0))
		: [];
	return {
		id: p.id,
		name: p.name || '',
		slug: p.slug || '',
		customDomain: settings.customDomain,
		redirectDomains: settings.redirectDomains,
		settings,
		components,
		incidents,
		scheduledMaintenances,
		uptimeData: (p.uptimeData && typeof p.uptimeData === 'object') ? p.uptimeData : {},
		overallStatus: computeOverallStatus(components),
		updatedAt: new Date().toISOString()
	};
}

function findProjectByDomain(domain, excludeProjectId) {
	const normalized = normalizeDomain(domain);
	if (!normalized) return null;
	for (const project of db.projects) {
		if (excludeProjectId && project.id === excludeProjectId) continue;
		const cfg = getProjectDomainConfig(project);
		if (cfg.primaryDomain === normalized || cfg.redirectDomains.includes(normalized)) return project;
	}
	return null;
}

function resolveProjectByHost(hostHeader) {
	const host = normalizeDomain(hostHeader || '');
	if (!host) return null;
	for (const project of db.projects) {
		const cfg = getProjectDomainConfig(project);
		if (cfg.primaryDomain && cfg.primaryDomain === host) {
			return { project, host, redirect: false, targetDomain: cfg.primaryDomain };
		}
	}
	for (const project of db.projects) {
		const cfg = getProjectDomainConfig(project);
		if (cfg.redirectDomains.includes(host)) {
			return { project, host, redirect: !!cfg.primaryDomain, targetDomain: cfg.primaryDomain || '' };
		}
	}
	return null;
}

module.exports = {
	initDb, getDb, saveData, nextId,
	getProjectBySlug, getProjectById,
	computeOverallStatus, getProjectDomainConfig,
	getPublicProjectSettings, getPublicProjectSnapshot,
	findProjectByDomain, resolveProjectByHost,
	defaultProject
};
