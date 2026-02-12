'use strict';

const { getProjectById, getProjectBySlug, resolveProjectByHost } = require('../services/dataStore');
const { buildRedirectUrl } = require('../services/domainService');

function projectMiddleware(req, res, next) {
	const proj = getProjectById(req.params.projectId);
	if (!proj) return res.status(404).json({ error: 'Project not found' });
	req.project = proj;
	next();
}

function slugMiddleware(req, res, next) {
	const proj = getProjectBySlug(req.params.slug);
	if (!proj) return res.status(404).json({ error: 'Project not found' });
	req.project = proj;
	next();
}

function hostResolverMiddleware(req, res, next) {
	const hostMatch = resolveProjectByHost(req.headers.host);
	if (hostMatch) {
		req.hostProject = hostMatch.project;
		if (hostMatch.redirect && hostMatch.targetDomain && req.method !== 'OPTIONS') {
			return res.redirect(308, buildRedirectUrl(req, hostMatch.targetDomain));
		}
	}
	next();
}

module.exports = { projectMiddleware, slugMiddleware, hostResolverMiddleware };
