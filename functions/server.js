'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');

// ── Initialize data layer ───────────────────────────────────────────────
const { PUBLIC_DIR } = require('./lib/constants');
const { safePublicPath } = require('./lib/helpers');
const { initDb, getProjectBySlug } = require('./services/dataStore');
const { trackProjectPageView } = require('./services/analyticsService');

// Middleware
const { securityMiddleware } = require('./middleware/security');
const { corsMiddleware } = require('./middleware/cors');
const { hostResolverMiddleware } = require('./middleware/projectResolver');
const { authMiddleware } = require('./middleware/auth');
const { projectMiddleware } = require('./middleware/projectResolver');

// Routes
const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const adminProjectRoutes = require('./routes/admin/projects');
const adminUserRoutes = require('./routes/admin/users');
const adminComponentRoutes = require('./routes/admin/components');
const adminIncidentRoutes = require('./routes/admin/incidents');
const adminMaintenanceRoutes = require('./routes/admin/maintenance');
const adminSubscriberRoutes = require('./routes/admin/subscribers');
const adminTemplateRoutes = require('./routes/admin/templates');
const adminSettingsRoutes = require('./routes/admin/settings');
const adminAnalyticsRoutes = require('./routes/admin/analytics');

// ── Boot database ───────────────────────────────────────────────────────
initDb();

// ── Express app ─────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.use(helmet({
	contentSecurityPolicy: {
		directives: {
			defaultSrc: ["'self'"],
			scriptSrc: ["'self'", "'unsafe-inline'"],
			scriptSrcAttr: null,
			styleSrc: ["'self'", "'unsafe-inline'"],
			imgSrc: ["'self'", 'data:', 'https:'],
			connectSrc: ["'self'", 'http://localhost:3000'],
			fontSrc: ["'self'"],
			frameSrc: ["'none'"],
			objectSrc: ["'none'"],
			baseUri: ["'self'"],
			formAction: ["'self'"]
		}
	},
	crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '1mb' }));
app.use((err, _req, res, next) => {
	if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON in request body' });
	next(err);
});
app.use(securityMiddleware);
app.use(hostResolverMiddleware);
app.use(express.static(path.join(__dirname, 'public'), {
	setHeaders: (res, filePath) => {
		if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
	}
}));
app.use(corsMiddleware);

// ── Public API ──────────────────────────────────────────────────────────
app.use('/api/v1', publicRoutes);

// ── Auth API ────────────────────────────────────────────────────────────
app.use('/api/v1/auth', authRoutes);

// ── Admin API — project CRUD ────────────────────────────────────────────
app.use('/api/v1/admin/projects', adminProjectRoutes);

// ── Admin API — user CRUD ───────────────────────────────────────────────
app.use('/api/v1/admin/users', adminUserRoutes);

// ── Admin API — project-scoped resources ────────────────────────────────
const projectRouter = express.Router({ mergeParams: true });
projectRouter.use(authMiddleware, projectMiddleware);
projectRouter.use('/components', adminComponentRoutes);
projectRouter.use('/incidents', adminIncidentRoutes);
projectRouter.use('/maintenances', adminMaintenanceRoutes);
projectRouter.use('/subscribers', adminSubscriberRoutes);
projectRouter.use(adminTemplateRoutes);   // /incident-templates, /maintenance-templates
projectRouter.use(adminSettingsRoutes);   // /settings, /domain-*, /email-*
projectRouter.use(adminAnalyticsRoutes);  // /stats, /analytics, /activity
app.use('/api/v1/admin/projects/:projectId', projectRouter);

// ── Health ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));
app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

// ── Legacy compatibility (deprecated — will be removed in v2) ───────────
app.get('/api/services', (_req, res) => {
	const { getDb } = require('./services/dataStore');
	const db = getDb();
	res.json(db.projects[0] ? db.projects[0].components : []);
});
app.get('/api/metrics', (req, res) => {
	const timespan = req.query.timespan || '7d';
	const days = Math.max(1, parseInt(('' + timespan).replace(/\D/g, '') || '7', 10));
	const data = Array.from({ length: days }, (_, i) => ({ date: new Date(Date.now() - (days - 1 - i) * 86400000).toISOString(), value: Math.round(10 + Math.random() * 90) }));
	res.json({ data });
});

app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Project permalink ───────────────────────────────────────────────────
app.get('/p/:slug', (req, res) => {
	const project = getProjectBySlug(req.params.slug);
	if (project) trackProjectPageView(project, req);
	res.setHeader('Cache-Control', 'no-store');
	res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ── SPA fallback ────────────────────────────────────────────────────────
app.get('*', (req, res) => {
	if ((req.path === '/' || req.path === '/index.html') && req.hostProject) {
		trackProjectPageView(req.hostProject, req);
	}
	const requestedFile = safePublicPath(req.path);
	if (requestedFile && fs.existsSync(requestedFile) && fs.statSync(requestedFile).isFile()) {
		if (requestedFile.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
		return res.sendFile(requestedFile);
	}
	res.setHeader('Cache-Control', 'no-store');
	res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ── Global error handler ────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
	console.error('Unhandled error:', err);
	if (!res.headersSent) {
		res.status(500).json({ error: 'Internal server error' });
	}
});

// ── Export for Cloud Functions ───────────────────────────────────────────
module.exports = app;

// ── Local dev server ────────────────────────────────────────────────────
if (require.main === module) {
	const port = parseInt(process.env.PORT || '3000', 10);
	const server = app.listen(port, () => console.log(`\u2713 Status page running at http://localhost:${port}`));
	server.on('error', (err) => {
		if (err.code === 'EADDRINUSE') { console.error(`Port ${port} in use`); process.exit(1); }
		console.error('Server error:', err);
		process.exit(1);
	});
}
