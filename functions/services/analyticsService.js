'use strict';

const crypto = require('crypto');
const { getDateKey } = require('../lib/helpers');
const { saveData } = require('./dataStore');

function ensureProjectAnalytics(project) {
	if (!project.analytics || typeof project.analytics !== 'object') project.analytics = {};
	if (!project.analytics.pageViewsByDay || typeof project.analytics.pageViewsByDay !== 'object') project.analytics.pageViewsByDay = {};
	if (!project.analytics.uniqueVisitorsByDay || typeof project.analytics.uniqueVisitorsByDay !== 'object') project.analytics.uniqueVisitorsByDay = {};
	if (!project.analytics.visitorHashesByDay || typeof project.analytics.visitorHashesByDay !== 'object') project.analytics.visitorHashesByDay = {};
}

function pruneAnalytics(project, now = Date.now()) {
	ensureProjectAnalytics(project);
	const cutoff = now - (120 * 86400000);
	const keys = new Set([
		...Object.keys(project.analytics.pageViewsByDay),
		...Object.keys(project.analytics.uniqueVisitorsByDay),
		...Object.keys(project.analytics.visitorHashesByDay)
	]);
	for (const key of keys) {
		const ts = new Date(key + 'T00:00:00.000Z').getTime();
		if (!Number.isFinite(ts) || ts < cutoff) {
			delete project.analytics.pageViewsByDay[key];
			delete project.analytics.uniqueVisitorsByDay[key];
			delete project.analytics.visitorHashesByDay[key];
		}
	}
}

function trackProjectPageView(project, req) {
	try {
		ensureProjectAnalytics(project);
		const day = getDateKey();
		project.analytics.pageViewsByDay[day] = (project.analytics.pageViewsByDay[day] || 0) + 1;

		const ipHeader = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
		const ip = ipHeader || (req.socket && req.socket.remoteAddress) || 'unknown';
		const ua = req.headers['user-agent'] || '';
		const hash = crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 16);

		const seen = Array.isArray(project.analytics.visitorHashesByDay[day]) ? project.analytics.visitorHashesByDay[day] : [];
		if (!seen.includes(hash)) {
			seen.push(hash);
			if (seen.length > 5000) seen.shift();
			project.analytics.visitorHashesByDay[day] = seen;
		}
		project.analytics.uniqueVisitorsByDay[day] = seen.length;
		project.analytics.updatedAt = new Date().toISOString();
		pruneAnalytics(project);
		saveData();
	} catch {
		// ignore analytics tracking errors
	}
}

function aggregateProjectAnalytics(project, days = 30) {
	ensureProjectAnalytics(project);
	pruneAnalytics(project);
	const safeDays = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
	const now = Date.now();
	const daily = [];
	let totalViews = 0;
	let totalUnique = 0;
	for (let i = safeDays - 1; i >= 0; i--) {
		const key = getDateKey(now - i * 86400000);
		const views = parseInt(project.analytics.pageViewsByDay[key] || 0, 10);
		const uniqueVisitors = parseInt(project.analytics.uniqueVisitorsByDay[key] || 0, 10);
		totalViews += views;
		totalUnique += uniqueVisitors;
		daily.push({ date: key, views, uniqueVisitors });
	}
	return { days: safeDays, totalViews, totalUnique, daily };
}

module.exports = { trackProjectPageView, aggregateProjectAnalytics };
