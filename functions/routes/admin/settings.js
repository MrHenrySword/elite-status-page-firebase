'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const {
	saveData, getProjectDomainConfig, findProjectByDomain
} = require('../../services/dataStore');
const {
	normalizeDomain, normalizeDomainList, splitDomainInput,
	isValidDomainHost, isValidEmail, sanitizeDisabledTabs
} = require('../../lib/helpers');
const { getExpectedDnsTarget, validateDomainDns } = require('../../services/domainService');
const { logAudit } = require('../../services/auditService');
const { requireEditor } = require('../../middleware/auth');

// ── Settings CRUD ───────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
	const settings = req.project.settings || {};
	const effectiveNotificationFromEmail = settings.notificationFromEmail || settings.supportEmail || '';
	res.json({
		...settings,
		effectiveNotificationFromEmail,
		customDomain: normalizeDomain(settings.customDomain || ''),
		redirectDomains: normalizeDomainList(settings.redirectDomains || [])
	});
});

router.put('/settings', requireEditor, (req, res) => {
	if (!req.project.settings) req.project.settings = {};
	const incoming = req.body || {};

	// Email validations
	if (Object.prototype.hasOwnProperty.call(incoming, 'supportEmail')) {
		const supportEmail = String(incoming.supportEmail || '').trim();
		if (supportEmail && !isValidEmail(supportEmail)) return res.status(400).json({ error: 'Invalid support email format' });
	}
	if (Object.prototype.hasOwnProperty.call(incoming, 'notificationFromEmail')) {
		const fromEmail = String(incoming.notificationFromEmail || '').trim();
		if (fromEmail && !isValidEmail(fromEmail)) return res.status(400).json({ error: 'Invalid send from email format' });
	}
	if (Object.prototype.hasOwnProperty.call(incoming, 'notificationReplyToEmail')) {
		const replyToEmail = String(incoming.notificationReplyToEmail || '').trim();
		if (replyToEmail && !isValidEmail(replyToEmail)) return res.status(400).json({ error: 'Invalid reply to email format' });
	}

	// Domain validations
	const nextCustomDomain = Object.prototype.hasOwnProperty.call(incoming, 'customDomain')
		? normalizeDomain(incoming.customDomain || '')
		: normalizeDomain(req.project.settings.customDomain || '');
	if (Object.prototype.hasOwnProperty.call(incoming, 'customDomain')) {
		const rawCustom = String(incoming.customDomain || '').trim();
		if (rawCustom && (!nextCustomDomain || !isValidDomainHost(nextCustomDomain))) {
			return res.status(400).json({ error: 'Invalid custom domain format' });
		}
	}
	let nextRedirectDomains = Object.prototype.hasOwnProperty.call(incoming, 'redirectDomains')
		? normalizeDomainList(incoming.redirectDomains || [])
		: normalizeDomainList(req.project.settings.redirectDomains || []);
	if (Object.prototype.hasOwnProperty.call(incoming, 'redirectDomains')) {
		const invalidRedirects = splitDomainInput(incoming.redirectDomains || []).filter(d => {
			const n = normalizeDomain(d);
			return !n || !isValidDomainHost(n);
		});
		if (invalidRedirects.length) {
			return res.status(400).json({ error: `Invalid redirect domain(s): ${invalidRedirects.join(', ')}` });
		}
	}
	nextRedirectDomains = nextRedirectDomains.filter(d => d !== nextCustomDomain);

	for (const domain of [nextCustomDomain, ...nextRedirectDomains]) {
		if (!domain) continue;
		const conflict = findProjectByDomain(domain, req.project.id);
		if (conflict) {
			return res.status(409).json({ error: `Domain already in use by project "${conflict.name}"` });
		}
	}

	// Sanitize updates
	const updates = { ...incoming };
	delete updates.customDomain;
	delete updates.redirectDomains;
	if (Object.prototype.hasOwnProperty.call(updates, 'hideFromSearchEngines')) updates.hideFromSearchEngines = !!updates.hideFromSearchEngines;
	if (Object.prototype.hasOwnProperty.call(updates, 'googleAnalyticsTrackingId')) updates.googleAnalyticsTrackingId = String(updates.googleAnalyticsTrackingId || '').trim();
	if (Object.prototype.hasOwnProperty.call(updates, 'defaultSmsCountryCode')) updates.defaultSmsCountryCode = String(updates.defaultSmsCountryCode || '+1').trim() || '+1';
	if (Object.prototype.hasOwnProperty.call(updates, 'supportEmail')) updates.supportEmail = String(updates.supportEmail || '').trim();
	if (Object.prototype.hasOwnProperty.call(updates, 'notificationFromName')) updates.notificationFromName = String(updates.notificationFromName || '').trim();
	if (Object.prototype.hasOwnProperty.call(updates, 'notificationFromEmail')) updates.notificationFromEmail = String(updates.notificationFromEmail || '').trim();
	if (Object.prototype.hasOwnProperty.call(updates, 'notificationReplyToEmail')) updates.notificationReplyToEmail = String(updates.notificationReplyToEmail || '').trim();
	if (Object.prototype.hasOwnProperty.call(updates, 'notificationFooterMessage')) updates.notificationFooterMessage = String(updates.notificationFooterMessage || '').trim();
	if (Object.prototype.hasOwnProperty.call(updates, 'notificationLogoUrl')) updates.notificationLogoUrl = String(updates.notificationLogoUrl || '').trim();
	if (Object.prototype.hasOwnProperty.call(updates, 'notificationUseStatusLogo')) updates.notificationUseStatusLogo = !!updates.notificationUseStatusLogo;
	if (Object.prototype.hasOwnProperty.call(updates, 'statusPageLogoUrl')) updates.statusPageLogoUrl = String(updates.statusPageLogoUrl || '').trim();
	if (Object.prototype.hasOwnProperty.call(updates, 'adminPanelLogoUrl')) updates.adminPanelLogoUrl = String(updates.adminPanelLogoUrl || '').trim();
	if (Object.prototype.hasOwnProperty.call(updates, 'displayMode')) {
		const validModes = ['single', 'dual', 'triad'];
		updates.displayMode = validModes.includes(updates.displayMode) ? updates.displayMode : 'single';
	}
	if (Object.prototype.hasOwnProperty.call(updates, 'secondaryProjectId')) updates.secondaryProjectId = updates.secondaryProjectId ? parseInt(updates.secondaryProjectId, 10) || null : null;
	if (Object.prototype.hasOwnProperty.call(updates, 'tertiaryProjectId')) updates.tertiaryProjectId = updates.tertiaryProjectId ? parseInt(updates.tertiaryProjectId, 10) || null : null;
	if (Object.prototype.hasOwnProperty.call(updates, 'domainAutomationProvider')) updates.domainAutomationProvider = String(updates.domainAutomationProvider || '').trim();
	if (Object.prototype.hasOwnProperty.call(updates, 'domainRegistrar')) updates.domainRegistrar = String(updates.domainRegistrar || '').trim();
	if (Object.prototype.hasOwnProperty.call(updates, 'dnsProvider')) updates.dnsProvider = String(updates.dnsProvider || '').trim();
	if (Object.prototype.hasOwnProperty.call(updates, 'domainContactEmail')) {
		const dce = String(updates.domainContactEmail || '').trim();
		if (dce && !isValidEmail(dce)) return res.status(400).json({ error: 'Invalid domain contact email', fieldErrors: { domainContactEmail: 'Invalid email format' } });
		updates.domainContactEmail = dce;
	}
	if (Object.prototype.hasOwnProperty.call(updates, 'dnsProviderAccountId')) updates.dnsProviderAccountId = String(updates.dnsProviderAccountId || '').trim();
	if (Object.prototype.hasOwnProperty.call(updates, 'dnsProviderZone')) updates.dnsProviderZone = String(updates.dnsProviderZone || '').trim();
	if (Object.prototype.hasOwnProperty.call(updates, 'disabledTabs')) updates.disabledTabs = sanitizeDisabledTabs(updates.disabledTabs);
	if (Object.prototype.hasOwnProperty.call(updates, 'pageName') && !Object.prototype.hasOwnProperty.call(updates, 'pageTitle')) {
		updates.pageTitle = updates.pageName;
	}
	if (Object.prototype.hasOwnProperty.call(updates, 'organizationLegalName') && !Object.prototype.hasOwnProperty.call(updates, 'companyName')) {
		updates.companyName = updates.organizationLegalName;
	}

	const changedFields = Object.keys(updates);
	if (Object.prototype.hasOwnProperty.call(incoming, 'customDomain')) changedFields.push('customDomain');
	if (Object.prototype.hasOwnProperty.call(incoming, 'redirectDomains')) changedFields.push('redirectDomains');
	Object.assign(req.project.settings, updates);
	if (Object.prototype.hasOwnProperty.call(incoming, 'customDomain')) req.project.settings.customDomain = nextCustomDomain;
	if (Object.prototype.hasOwnProperty.call(incoming, 'customDomain') || Object.prototype.hasOwnProperty.call(incoming, 'redirectDomains')) {
		req.project.settings.redirectDomains = nextRedirectDomains;
	}
	saveData();
	logAudit(req.user, 'settings.update', { projectId: req.project.id, fields: changedFields });
	const effectiveNotificationFromEmail = req.project.settings.notificationFromEmail || req.project.settings.supportEmail || '';
	res.json({
		...req.project.settings,
		effectiveNotificationFromEmail,
		customDomain: normalizeDomain(req.project.settings.customDomain || ''),
		redirectDomains: normalizeDomainList(req.project.settings.redirectDomains || [])
	});
});

// ── Domain Config / Validation / Provisioning ───────────────────────────

router.get('/domain-config', (req, res) => {
	const cfg = getProjectDomainConfig(req.project);
	const expectedTarget = getExpectedDnsTarget(req.headers.host);
	res.json({
		customDomain: cfg.primaryDomain,
		redirectDomains: cfg.redirectDomains,
		expectedTarget,
		instructions: {
			primary: expectedTarget ? `Set CNAME ${cfg.primaryDomain || '<custom-domain>'} -> ${expectedTarget}` : 'Set CUSTOM_DOMAIN_TARGET env var to show the expected CNAME target.',
			redirect: cfg.primaryDomain ? `Point redirect domains to ${cfg.primaryDomain} (or to the same app target).` : 'Set a primary custom domain first.'
		}
	});
});

router.post('/domain-validate', async (req, res) => {
	const cfg = getProjectDomainConfig(req.project);
	const requestedDomain = normalizeDomain(req.body && req.body.domain ? req.body.domain : '');
	if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'domain') && !requestedDomain) {
		return res.status(400).json({ error: 'Invalid domain format' });
	}
	const domains = requestedDomain
		? [requestedDomain]
		: [cfg.primaryDomain, ...cfg.redirectDomains].filter(Boolean);
	if (!domains.length) return res.status(400).json({ error: 'No domains configured for this project' });
	const expectedTarget = getExpectedDnsTarget(req.headers.host);
	const results = [];
	for (const domain of [...new Set(domains)]) {
		const target = domain === cfg.primaryDomain ? expectedTarget : (cfg.primaryDomain || expectedTarget);
		results.push(await validateDomainDns(domain, target));
	}
	res.json({
		projectId: req.project.id,
		expectedTarget,
		validatedAt: new Date().toISOString(),
		allOk: results.every(r => r.status === 'ok'),
		results
	});
});

router.get('/domain-provision-status', (req, res) => {
	const firebaseProjectId = process.env.FIREBASE_PROJECT_ID || '';
	const firebaseHostingSite = process.env.FIREBASE_HOSTING_SITE || '';
	const enabled = !!(firebaseProjectId && firebaseHostingSite);
	res.json({
		enabled,
		firebaseProjectId: firebaseProjectId || null,
		firebaseHostingSite: firebaseHostingSite || null,
		message: enabled ? 'Domain automation is available' : 'Set FIREBASE_PROJECT_ID and FIREBASE_HOSTING_SITE env vars to enable domain provisioning'
	});
});

router.post('/domain-provision', requireEditor, (req, res) => {
	const firebaseProjectId = process.env.FIREBASE_PROJECT_ID || '';
	const firebaseHostingSite = process.env.FIREBASE_HOSTING_SITE || '';
	if (!firebaseProjectId || !firebaseHostingSite) {
		return res.status(400).json({ error: 'Domain automation is not configured. Set FIREBASE_PROJECT_ID and FIREBASE_HOSTING_SITE.' });
	}
	const customDomain = normalizeDomain((req.project.settings || {}).customDomain || '');
	if (!customDomain) return res.status(400).json({ error: 'No custom domain set for this project' });
	logAudit(req.user, 'domain.provision', { projectId: req.project.id, domain: customDomain });
	res.json({ status: 'queued', domain: customDomain, message: 'Domain provisioning requested (requires Firebase Hosting API integration)' });
});

// ── Email Status / Test ─────────────────────────────────────────────────

router.get('/email-status', (req, res) => {
	const smtpHost = process.env.SMTP_HOST || '';
	const smtpPort = process.env.SMTP_PORT || '';
	const smtpUser = process.env.SMTP_USER || '';
	const smtpPass = process.env.SMTP_PASS || '';
	const fromEmail = process.env.NOTIFICATION_FROM_EMAIL || (req.project.settings || {}).notificationFromEmail || '';
	const replyTo = process.env.NOTIFICATION_REPLY_TO || (req.project.settings || {}).notificationReplyToEmail || '';
	const missingConfig = [];
	if (!smtpHost) missingConfig.push('SMTP_HOST');
	if (!smtpPort) missingConfig.push('SMTP_PORT');
	if (!smtpUser) missingConfig.push('SMTP_USER');
	if (!smtpPass) missingConfig.push('SMTP_PASS');
	if (!fromEmail) missingConfig.push('NOTIFICATION_FROM_EMAIL');
	res.json({
		provider: smtpHost ? 'smtp' : 'none',
		enabled: !!(smtpHost && smtpPort && smtpUser && smtpPass && fromEmail),
		missingConfig,
		smtp: { host: smtpHost, port: smtpPort, secure: String(smtpPort) === '465', hasAuth: !!(smtpUser && smtpPass) },
		sender: { fromEmail, replyTo }
	});
});

router.post('/email-test', requireEditor, (req, res) => {
	const smtpHost = process.env.SMTP_HOST || '';
	const smtpPort = process.env.SMTP_PORT || '';
	const smtpUser = process.env.SMTP_USER || '';
	const smtpPass = process.env.SMTP_PASS || '';
	const fromEmail = process.env.NOTIFICATION_FROM_EMAIL || (req.project.settings || {}).notificationFromEmail || '';
	const missingConfig = [];
	if (!smtpHost) missingConfig.push('SMTP_HOST');
	if (!smtpPort) missingConfig.push('SMTP_PORT');
	if (!smtpUser) missingConfig.push('SMTP_USER');
	if (!smtpPass) missingConfig.push('SMTP_PASS');
	if (!fromEmail) missingConfig.push('NOTIFICATION_FROM_EMAIL');
	if (missingConfig.length) {
		return res.status(400).json({ error: 'Email delivery is not configured', missingConfig });
	}
	const to = String((req.body && req.body.email) || (req.project.settings || {}).supportEmail || '').trim();
	if (!to || !isValidEmail(to)) return res.status(400).json({ error: 'Valid recipient email required' });
	logAudit(req.user, 'email.test', { projectId: req.project.id, to });
	res.json({ sent: true, to, from: fromEmail, message: 'Test email queued (SMTP delivery requires nodemailer integration)' });
});

module.exports = router;
