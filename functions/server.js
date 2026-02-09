const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const dns = require('dns').promises;
const net = require('net');

let app;
let usingExpress = false;

// ── Data persistence (JSON file) ────────────────────────────────────────
const AZURE_DATA_DIR = '/home/data';
const isAzure = !!process.env.WEBSITE_SITE_NAME;
const dataDir = isAzure ? AZURE_DATA_DIR : __dirname;
if (isAzure && !fs.existsSync(AZURE_DATA_DIR)) fs.mkdirSync(AZURE_DATA_DIR, { recursive: true });
const DATA_FILE = path.join(dataDir, 'data.json');
const LOG_FILE = path.join(dataDir, 'audit.log');
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUTH_COOKIE_NAME = 'statusPageToken';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = Math.max(10, Math.min(15, parseInt(process.env.BCRYPT_ROUNDS || '12', 10) || 12));
const RATE_LIMIT_WINDOW_MS = Math.max(1000, parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10) || 900000);
const RATE_LIMIT_MAX_REQUESTS = Math.max(1, parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '10', 10) || 10);
const PASSWORD_MIGRATION_VERSION = 1;
const CORS_ALLOWED_ORIGINS = String(process.env.CORS_ORIGIN || '')
	.split(',')
	.map(v => v.trim())
	.filter(Boolean);
const loginRateBuckets = new Map();

function appendVary(existing, value) {
	if (!existing) return value;
	const parts = String(existing).split(',').map(v => v.trim()).filter(Boolean);
	if (!parts.includes(value)) parts.push(value);
	return parts.join(', ');
}

function isOriginAllowed(req, origin) {
	if (!origin) return true;
	if (CORS_ALLOWED_ORIGINS.length > 0) return CORS_ALLOWED_ORIGINS.includes(origin);
	const host = String(req.headers.host || '').trim();
	if (!host) return false;
	return origin === `http://${host}` || origin === `https://${host}`;
}

function applyCorsHeaders(req, res) {
	const origin = req.headers.origin;
	if (origin && isOriginAllowed(req, origin)) {
		res.setHeader('Access-Control-Allow-Origin', origin);
		res.setHeader('Access-Control-Allow-Credentials', 'true');
		res.setHeader('Vary', appendVary(res.getHeader('Vary'), 'Origin'));
	}
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function applySecurityHeaders(res) {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('X-Frame-Options', 'DENY');
	res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
	res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function parseCookies(header) {
	const out = {};
	const raw = String(header || '');
	if (!raw) return out;
	for (const part of raw.split(';')) {
		const idx = part.indexOf('=');
		if (idx <= 0) continue;
		const key = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (!key) continue;
		try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
	}
	return out;
}

function tokenFromRequest(req) {
	const authHeader = req.headers.authorization || '';
	if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
	const cookies = parseCookies(req.headers.cookie);
	return cookies[AUTH_COOKIE_NAME] || '';
}

function authCookieOptions(req) {
	return {
		httpOnly: true,
		sameSite: 'lax',
		secure: requestProtocol(req, req.headers.host) === 'https',
		path: '/',
		maxAge: TOKEN_TTL_MS
	};
}

function toCookieHeader(name, value, options = {}) {
	const parts = [`${name}=${encodeURIComponent(value || '')}`];
	parts.push(`Path=${options.path || '/'}`);
	if (options.httpOnly) parts.push('HttpOnly');
	if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
	if (options.secure) parts.push('Secure');
	if (typeof options.maxAge === 'number') parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
	return parts.join('; ');
}

function setAuthCookieExpress(req, res, token) {
	res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions(req));
}

function clearAuthCookieExpress(req, res) {
	const opts = authCookieOptions(req);
	res.cookie(AUTH_COOKIE_NAME, '', { ...opts, maxAge: 0 });
}

function setAuthCookieHeader(req, res, token) {
	res.setHeader('Set-Cookie', toCookieHeader(AUTH_COOKIE_NAME, token, authCookieOptions(req)));
}

function clearAuthCookieHeader(req, res) {
	res.setHeader('Set-Cookie', toCookieHeader(AUTH_COOKIE_NAME, '', { ...authCookieOptions(req), maxAge: 0 }));
}

function clientIp(req) {
	const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
	if (forwarded) return forwarded;
	return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function consumeLoginRateLimit(req, username) {
	const key = `${clientIp(req)}|${String(username || '').trim().toLowerCase() || 'unknown'}`;
	const now = Date.now();
	let entry = loginRateBuckets.get(key);
	if (!entry || entry.expiresAt <= now) {
		entry = { count: 0, expiresAt: now + RATE_LIMIT_WINDOW_MS };
	}
	entry.count += 1;
	loginRateBuckets.set(key, entry);

	// Opportunistic cleanup
	if (loginRateBuckets.size > 5000) {
		for (const [k, v] of loginRateBuckets) {
			if (v.expiresAt <= now) loginRateBuckets.delete(k);
		}
	}

	return { key, allowed: entry.count <= RATE_LIMIT_MAX_REQUESTS };
}

function resetLoginRateLimit(key) {
	if (key) loginRateBuckets.delete(key);
}

function safePublicPath(rawPath) {
	try {
		const decoded = decodeURIComponent(String(rawPath || '/'));
		const normalized = path.posix.normalize(decoded.replace(/\\/g, '/'));
		if (normalized.includes('\0')) return null;
		if (normalized.startsWith('/..') || normalized === '/..' || normalized.includes('/../')) return null;
		const relative = normalized.replace(/^\/+/, '');
		if (relative.split('/').some(seg => seg.startsWith('.'))) return null;
		const candidate = path.resolve(PUBLIC_DIR, relative || 'index.html');
		const root = path.resolve(PUBLIC_DIR) + path.sep;
		if (candidate !== path.resolve(PUBLIC_DIR) && !candidate.startsWith(root)) return null;
		return candidate;
	} catch {
		return null;
	}
}

function makeSlug(name) {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeDomain(value) {
	if (!value || typeof value !== 'string') return '';
	let input = value.trim().toLowerCase();
	if (!input) return '';
	if (!input.includes('://')) input = 'http://' + input;
	try {
		const host = new URL(input).hostname.toLowerCase().replace(/\.+$/, '');
		return host;
	} catch {
		return '';
	}
}

function splitDomainInput(value) {
	const raw = Array.isArray(value) ? value.join(',') : String(value || '');
	return raw.split(/[\s,]+/).map(v => v.trim()).filter(Boolean);
}

function normalizeDomainList(value) {
	const parts = splitDomainInput(value).map(normalizeDomain).filter(Boolean);
	return [...new Set(parts)];
}

function isValidDomainHost(host) {
	if (!host || typeof host !== 'string') return false;
	if (net.isIP(host)) return true;
	if (host === 'localhost') return true;
	if (host.length > 253 || !host.includes('.')) return false;
	const labels = host.split('.');
	return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function isValidEmail(value) {
	if (!value || typeof value !== 'string') return false;
	const v = value.trim();
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function getProjectDomainConfig(project) {
	const primaryDomain = normalizeDomain(project && project.settings ? project.settings.customDomain : '');
	const redirectDomains = normalizeDomainList(project && project.settings ? project.settings.redirectDomains : [])
		.filter(d => d !== primaryDomain);
	return { primaryDomain, redirectDomains };
}

function getExpectedDnsTarget(hostHeader) {
	return normalizeDomain(process.env.CUSTOM_DOMAIN_TARGET || process.env.WEBSITE_HOSTNAME || hostHeader || '');
}

const ALLOWED_DISABLED_TABS = new Set(['components', 'incidents', 'maintenance', 'subscribers', 'projects', 'users', 'settings']);

function sanitizeDisabledTabs(input) {
	if (!input || typeof input !== 'object') return {};
	const out = {};
	for (const key of ALLOWED_DISABLED_TABS) {
		if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = !!input[key];
	}
	return out;
}

async function resolveDnsSafe(method, host) {
	try {
		return await dns[method](host);
	} catch (err) {
		if (['ENODATA', 'ENOTFOUND', 'ENOTIMP', 'EREFUSED', 'SERVFAIL', 'ETIMEOUT'].includes(err.code)) return [];
		return [];
	}
}

async function validateDomainDns(domain, expectedTarget) {
	const host = normalizeDomain(domain);
	const target = normalizeDomain(expectedTarget || '');
	const result = {
		domain: host,
		expectedTarget: target,
		validFormat: !!host && isValidDomainHost(host),
		resolves: false,
		pointsToExpected: null,
		cnameRecords: [],
		aRecords: [],
		aaaaRecords: [],
		status: 'error',
		notes: []
	};

	if (!result.validFormat) {
		result.notes.push('Invalid domain format');
		return result;
	}

	result.cnameRecords = (await resolveDnsSafe('resolveCname', host)).map(normalizeDomain).filter(Boolean);
	result.aRecords = await resolveDnsSafe('resolve4', host);
	result.aaaaRecords = await resolveDnsSafe('resolve6', host);
	result.resolves = result.cnameRecords.length > 0 || result.aRecords.length > 0 || result.aaaaRecords.length > 0;

	if (!result.resolves) {
		result.status = 'error';
		result.notes.push('No DNS records found');
		return result;
	}

	if (!target) {
		result.status = 'ok';
		result.notes.push('DNS resolves (expected target not configured on server)');
		return result;
	}

	let pointsToTarget = result.cnameRecords.includes(target);
	if (!pointsToTarget) {
		const expectedA = await resolveDnsSafe('resolve4', target);
		const expectedAAAA = await resolveDnsSafe('resolve6', target);
		const expectedIps = new Set([...expectedA, ...expectedAAAA]);
		pointsToTarget = result.aRecords.some(ip => expectedIps.has(ip)) || result.aaaaRecords.some(ip => expectedIps.has(ip));
	}

	result.pointsToExpected = pointsToTarget;
	if (pointsToTarget) {
		result.status = 'ok';
		result.notes.push('DNS points to expected target');
	} else {
		result.status = 'warning';
		result.notes.push('DNS resolves but does not yet match expected target');
	}
	return result;
}

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
		components: [
			{ id: id * 1000 + 10, parentId: null, name: 'API Gateway', description: 'Main API endpoint', status: 'operational', order: 0, showUptime: true, createdAt: new Date().toISOString() },
			{ id: id * 1000 + 11, parentId: id * 1000 + 10, name: 'Database', description: 'Primary data store', status: 'operational', order: 1, showUptime: true, createdAt: new Date().toISOString() },
			{ id: id * 1000 + 12, parentId: id * 1000 + 10, name: 'Authentication Service', description: 'User authentication & SSO', status: 'operational', order: 2, showUptime: true, createdAt: new Date().toISOString() },
			{ id: id * 1000 + 13, parentId: null, name: 'Web Application', description: 'Main web interface', status: 'operational', order: 0, showUptime: true, createdAt: new Date().toISOString() },
			{ id: id * 1000 + 14, parentId: id * 1000 + 13, name: 'CDN', description: 'Content delivery network', status: 'operational', order: 1, showUptime: true, createdAt: new Date().toISOString() },
			{ id: id * 1000 + 15, parentId: id * 1000 + 13, name: 'Email Service', description: 'Transactional email', status: 'operational', order: 0, showUptime: true, createdAt: new Date().toISOString() }
		],
		incidents: [],
		scheduledMaintenances: [],
		subscribers: [],
		uptimeData: {},
		analytics: { pageViewsByDay: {}, uniqueVisitorsByDay: {}, visitorHashesByDay: {}, updatedAt: new Date().toISOString() },
		createdAt: new Date().toISOString()
	};
}

function defaultData() {
	return {
		users: buildInitialUsers(),
		projects: [defaultProject(1, '3E Elite', 'default')],
		nextId: 2000
	};
}

function legacyHashPassword(pw) {
	return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

function hashPassword(pw) {
	return bcrypt.hashSync(String(pw), BCRYPT_ROUNDS);
}

function isLegacyPasswordHash(value) {
	return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function verifyPassword(pw, hash) {
	if (!hash || typeof hash !== 'string') return false;
	if (hash.startsWith('$2')) {
		try { return bcrypt.compareSync(String(pw), hash); } catch { return false; }
	}
	if (isLegacyPasswordHash(hash)) return legacyHashPassword(pw) === hash;
	return false;
}

function shouldRehashPassword(hash) {
	if (!hash || typeof hash !== 'string') return true;
	if (isLegacyPasswordHash(hash)) return true;
	if (!hash.startsWith('$2')) return true;
	try {
		return bcrypt.getRounds(hash) < BCRYPT_ROUNDS;
	} catch {
		return true;
	}
}

function buildInitialUsers() {
	const email = String(process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
	const password = String(process.env.INITIAL_ADMIN_PASSWORD || '');
	if (!email || !password) return [];
	if (!isValidEmail(email) || password.length < 12) return [];
	return [{
		id: 1,
		username: email,
		email,
		name: 'Initial Admin',
		passwordHash: hashPassword(password),
		role: 'admin',
		createdAt: new Date().toISOString()
	}];
}

function ensureInitialUsers(data) {
	if (!Array.isArray(data.users)) data.users = [];
	if (data.users.length > 0) return;
	const seeded = buildInitialUsers();
	if (seeded.length > 0) {
		data.users = seeded;
	}
}

function parseMigrationPasswordMap() {
	const raw = String(process.env.LEGACY_PASSWORD_MAP_JSON || '').trim();
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		console.warn('LEGACY_PASSWORD_MAP_JSON is not valid JSON; startup password migration map ignored.');
		return {};
	}
}

function migrateLegacyPasswordHashes(data) {
	const enabled = ['1', 'true', 'yes'].includes(String(process.env.RUN_LEGACY_PASSWORD_MIGRATION || '').toLowerCase());
	if (!enabled) return false;
	if (!data || !Array.isArray(data.users) || data.users.length === 0) return false;

	const migrations = (data.securityMigrations && typeof data.securityMigrations === 'object') ? data.securityMigrations : {};
	const prior = migrations.legacySha256ToBcrypt;
	if (prior && prior.version === PASSWORD_MIGRATION_VERSION && prior.completed) return false;

	const passwordMap = parseMigrationPasswordMap();
	let changed = false;
	let migrated = 0;
	const unresolvedUsernames = [];
	for (const user of data.users) {
		if (!isLegacyPasswordHash(user.passwordHash)) continue;
		const lookupKeys = [String(user.username || ''), String(user.email || ''), String(user.id)];
		let plain = '';
		for (const key of lookupKeys) {
			if (Object.prototype.hasOwnProperty.call(passwordMap, key) && typeof passwordMap[key] === 'string') {
				plain = passwordMap[key];
				break;
			}
		}
		// Auto-migrate old demo admin hash without requiring a map entry.
		if (!plain && String(user.username || '').toLowerCase() === 'admin' && user.passwordHash === legacyHashPassword('admin123')) {
			plain = 'admin123';
		}
		if (!plain || legacyHashPassword(plain) !== user.passwordHash) {
			unresolvedUsernames.push(user.username || user.email || String(user.id));
			continue;
		}
		user.passwordHash = hashPassword(plain);
		migrated += 1;
		changed = true;
	}

	const remainingLegacy = data.users.filter(u => isLegacyPasswordHash(u.passwordHash)).length;
	data.securityMigrations = migrations;
	data.securityMigrations.legacySha256ToBcrypt = {
		version: PASSWORD_MIGRATION_VERSION,
		ranAt: new Date().toISOString(),
		migratedUsers: migrated,
		remainingLegacyUsers: remainingLegacy,
		completed: remainingLegacy === 0
	};
	if (unresolvedUsernames.length > 0) {
		console.warn(`Legacy password hashes still present for users: ${unresolvedUsernames.join(', ')}`);
	}
	if (migrated > 0) {
		console.log(`Migrated ${migrated} legacy SHA-256 password hash(es) to bcrypt.`);
	}
	return changed;
}

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
	} catch (e) { /* ignore, use default */ }
	return defaultData();
}

function saveData(data) {
	try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8'); }
	catch (e) { console.error('Failed to save data:', e.message); }
}

function logAudit(user, action, meta) {
	try {
		const entry = {
			at: new Date().toISOString(),
			user: user ? { id: user.id, username: user.username, role: user.role } : null,
			action,
			meta: meta || {}
		};
		fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
	} catch (e) { /* ignore logging errors */ }
}

let db = loadData();
if (migrateLegacyPasswordHashes(db)) saveData(db);
if (!Array.isArray(db.users) || db.users.length === 0) {
	console.warn('No admin users configured. Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD before first login.');
}

function nextId() { db.nextId = (db.nextId || 2000) + 1; return db.nextId; }

function getProjectBySlug(slug) { return db.projects.find(p => p.slug === slug); }
function getProjectById(id) { return db.projects.find(p => p.id === parseInt(id)); }

function computeOverallStatus(components) {
	let overall = 'operational';
	const list = Array.isArray(components) ? components : [];
	if (list.some((c) => c.status === 'major_outage')) overall = 'major_outage';
	else if (list.some((c) => c.status === 'partial_outage')) overall = 'partial_outage';
	else if (list.some((c) => c.status === 'degraded_performance')) overall = 'degraded_performance';
	else if (list.some((c) => c.status === 'under_maintenance')) overall = 'under_maintenance';
	return overall;
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
		redirectDomains: normalizeDomainList(settings.redirectDomains || [])
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

function requestProtocol(req, fallbackHost) {
	const forwarded = ((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim();
	if (forwarded) return forwarded;
	if (req.protocol) return req.protocol;
	const host = normalizeDomain(fallbackHost || '');
	if (host === 'localhost' || host === '127.0.0.1') return 'http';
	return 'https';
}

function buildRedirectUrl(req, targetDomain) {
	const proto = requestProtocol(req, targetDomain);
	const original = req.originalUrl || req.url || '/';
	return `${proto}://${targetDomain}${original}`;
}

function getDateKey(dateValue) {
	const d = dateValue ? new Date(dateValue) : new Date();
	return d.toISOString().slice(0, 10);
}

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
		saveData(db);
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

function summarizeAuditAction(action, meta) {
	const m = meta || {};
	if (action === 'settings.update') {
		const fields = Array.isArray(m.fields) ? m.fields.filter(Boolean) : [];
		if (fields.length) return `Updated settings (${fields.slice(0, 4).join(', ')}${fields.length > 4 ? ', ...' : ''})`;
		return 'Updated project settings';
	}
	const map = {
		'project.create': `Created project "${m.name || ''}"`,
		'project.update': 'Updated project details',
		'project.delete': 'Deleted project',
		'component.create': 'Created component',
		'component.update': 'Updated component',
		'component.reorder': 'Reordered components',
		'component.delete': 'Deleted component',
		'incident.create': 'Created incident',
		'incident.update': 'Updated incident',
		'incident.delete': 'Deleted incident',
		'maintenance.create': 'Created scheduled maintenance',
		'maintenance.update': 'Updated scheduled maintenance',
		'maintenance.delete': 'Deleted scheduled maintenance',
		'subscriber.delete': 'Removed subscriber',
		'user.create': 'Created user',
		'user.update': 'Updated user',
		'user.delete': 'Deleted user',
		'auth.login': 'Logged in'
	};
	return map[action] || action;
}

function readAuditEntries(limit = 50) {
	try {
		if (!fs.existsSync(LOG_FILE)) return [];
		const raw = fs.readFileSync(LOG_FILE, 'utf-8');
		const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
		const parsed = [];
		for (let i = lines.length - 1; i >= 0 && parsed.length < limit; i--) {
			try { parsed.push(JSON.parse(lines[i])); } catch { /* ignore bad line */ }
		}
		return parsed;
	} catch {
		return [];
	}
}

// ── JWT ─────────────────────────────────────────────────────────────────
const SECRET = String(process.env.JWT_SECRET || '').trim();
if (!SECRET || SECRET.length < 32) {
	throw new Error('JWT_SECRET must be set and at least 32 characters long.');
}

function createToken(payload) {
	const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
	const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
	const sig = crypto.createHmac('sha256', SECRET).update(header + '.' + body).digest('base64url');
	return header + '.' + body + '.' + sig;
}

function verifyToken(token) {
	try {
		const [header, body, sig] = token.split('.');
		if (!header || !body || !sig) return null;
		const expectedSig = crypto.createHmac('sha256', SECRET).update(header + '.' + body).digest('base64url');
		if (sig !== expectedSig) return null;
		const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
		if (payload.exp < Date.now()) return null;
		return payload;
	} catch { return null; }
}

function authMiddleware(req, res, next) {
	const payload = verifyToken(tokenFromRequest(req));
	if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
	req.user = payload;
	next();
}

function loginRateLimitMiddleware(req, res, next) {
	const username = String((req.body && req.body.username) || '').trim().toLowerCase();
	const result = consumeLoginRateLimit(req, username);
	req.loginRateLimitKey = result.key;
	if (!result.allowed) return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
	next();
}

function requireAdmin(req, res, next) {
	if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
	next();
}

function requireEditor(req, res, next) {
	if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'editor')) {
		return res.status(403).json({ error: 'Forbidden' });
	}
	next();
}

// Middleware: resolve project by :projectId param (admin routes use numeric id)
function projectMiddleware(req, res, next) {
	const proj = getProjectById(req.params.projectId);
	if (!proj) return res.status(404).json({ error: 'Project not found' });
	req.project = proj;
	next();
}

// Middleware: resolve project by :slug param (public routes)
function slugMiddleware(req, res, next) {
	const proj = getProjectBySlug(req.params.slug);
	if (!proj) return res.status(404).json({ error: 'Project not found' });
	req.project = proj;
	next();
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
	saveData(db);
}
seedUptime();

// ── Express setup ───────────────────────────────────────────────────────
try {
	const express = require('express');
	const helmet = require('helmet');
	app = express();
	usingExpress = true;
	app.disable('x-powered-by');
	app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
	app.use(express.json({ limit: '1mb' }));
	app.use((req, res, next) => {
		applySecurityHeaders(res);
		next();
	});
	app.use((req, res, next) => {
		const hostMatch = resolveProjectByHost(req.headers.host);
		if (hostMatch) {
			req.hostProject = hostMatch.project;
			if (hostMatch.redirect && hostMatch.targetDomain && req.method !== 'OPTIONS') {
				return res.redirect(308, buildRedirectUrl(req, hostMatch.targetDomain));
			}
		}
		next();
	});
	app.use(express.static(path.join(__dirname, 'public'), {
		setHeaders: (res, filePath) => {
			if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
		}
	}));

	app.use((req, res, next) => {
		const origin = req.headers.origin;
		const allowed = isOriginAllowed(req, origin);
		applyCorsHeaders(req, res);
		if (origin && !allowed) {
			if (req.method === 'OPTIONS') return res.status(403).end();
			return res.status(403).json({ error: 'Origin not allowed' });
		}
		if (req.method === 'OPTIONS') return res.status(204).end();
		next();
	});

	// ═══════════════════════════════════════════════════════════════════
	//  PUBLIC API — project-scoped by slug
	// ═══════════════════════════════════════════════════════════════════

	// List all projects (public, for project picker)
	app.get('/api/v1/projects', (_req, res) => {
		res.setHeader('Cache-Control', 'public,max-age=60,stale-while-revalidate=120');
		res.json(db.projects.map(p => ({ id: p.id, name: p.name, slug: p.slug })));
	});

	// Resolve current project by host header (for custom domain publishing)
	app.get('/api/v1/project-context', (req, res) => {
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

	app.get('/api/v1/projects/:slug/status', slugMiddleware, (req, res) => {
		res.json({ status: computeOverallStatus(req.project.components), updatedAt: new Date().toISOString() });
	});

	app.get('/api/v1/projects/:slug/components', slugMiddleware, (req, res) => {
		const p = req.project;
		res.json({ components: (p.components || []).sort((a, b) => a.order - b.order) });
	});

	app.get('/api/v1/projects/:slug/incidents', slugMiddleware, (req, res) => {
		const { status, days } = req.query;
		let list = [...req.project.incidents].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
		if (status === 'active') list = list.filter(i => i.status !== 'resolved' && i.status !== 'postmortem');
		if (days) { const cutoff = Date.now() - parseInt(days) * 86400000; list = list.filter(i => new Date(i.createdAt).getTime() > cutoff); }
		res.json(list);
	});

	app.get('/api/v1/projects/:slug/incidents/:id', slugMiddleware, (req, res) => {
		const inc = req.project.incidents.find(i => i.id === parseInt(req.params.id));
		if (!inc) return res.status(404).json({ error: 'Not found' });
		res.json(inc);
	});

	app.get('/api/v1/projects/:slug/scheduled-maintenances', slugMiddleware, (req, res) => {
		const now = new Date();
		const list = (req.project.scheduledMaintenances || [])
			.filter(m => new Date(m.scheduledEnd) > now || m.status !== 'completed')
			.sort((a, b) => new Date(a.scheduledStart) - new Date(b.scheduledStart));
		res.json(list);
	});

	app.get('/api/v1/projects/:slug/uptime', slugMiddleware, (req, res) => {
		res.json(req.project.uptimeData || {});
	});

	app.get('/api/v1/projects/:slug/settings', slugMiddleware, (req, res) => {
		res.json(getPublicProjectSettings(req.project));
	});

	app.get('/api/v1/projects/:slug/public-snapshot', slugMiddleware, (req, res) => {
		res.setHeader('Cache-Control', 'public,max-age=15,stale-while-revalidate=30');
		res.json(getPublicProjectSnapshot(req.project));
	});

	app.post('/api/v1/projects/:slug/subscribers', slugMiddleware, (req, res) => {
		const p = req.project;
		const { email, webhook } = req.body || {};
		if (!email && !webhook) return res.status(400).json({ error: 'Email or webhook URL required' });
		if (email && p.subscribers.find(s => s.email === email)) return res.status(409).json({ error: 'Already subscribed' });
		p.subscribers.push({ id: nextId(), email: email || null, webhook: webhook || null, confirmed: true, createdAt: new Date().toISOString() });
		saveData(db);
		res.status(201).json({ message: 'Subscribed successfully' });
	});

	// ═══════════════════════════════════════════════════════════════════
	//  AUTH
	// ═══════════════════════════════════════════════════════════════════

	app.post('/api/v1/auth/login', loginRateLimitMiddleware, (req, res) => {
		const { username, password } = req.body || {};
		if (!Array.isArray(db.users) || db.users.length === 0) {
			return res.status(503).json({ error: 'No users configured. Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD, then restart.' });
		}
		const loginName = String(username || '').trim().toLowerCase();
		const user = db.users.find(u => (u.username === loginName || u.email === loginName));
		if (!user || !verifyPassword(password, user.passwordHash)) return res.status(401).json({ error: 'Invalid credentials' });
		if (shouldRehashPassword(user.passwordHash)) {
			user.passwordHash = hashPassword(password);
			saveData(db);
		}
		resetLoginRateLimit(req.loginRateLimitKey);
		const token = createToken({ id: user.id, username: user.username, role: user.role });
		setAuthCookieExpress(req, res, token);
		logAudit(user, 'auth.login', {});
		res.json({ user: { id: user.id, username: user.username, role: user.role } });
	});

	app.get('/api/v1/auth/me', authMiddleware, (req, res) => { res.json(req.user); });
	app.post('/api/v1/auth/logout', (req, res) => {
		clearAuthCookieExpress(req, res);
		res.status(204).end();
	});

	// ═══════════════════════════════════════════════════════════════════
	//  ADMIN API — project CRUD
	// ═══════════════════════════════════════════════════════════════════

	app.get('/api/v1/admin/projects', authMiddleware, (_req, res) => {
		res.json(db.projects.map((p) => {
			const cfg = getProjectDomainConfig(p);
			return { id: p.id, name: p.name, slug: p.slug, customDomain: cfg.primaryDomain, createdAt: p.createdAt };
		}));
	});

	app.post('/api/v1/admin/projects', authMiddleware, requireEditor, (req, res) => {
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
		saveData(db);
		logAudit(req.user, 'project.create', { projectId: proj.id, name: proj.name, slug: proj.slug });
		res.status(201).json({ id: proj.id, name: proj.name, slug: proj.slug });
	});

	app.put('/api/v1/admin/projects/:projectId', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
		const p = req.project;
		if (req.body.name) p.name = req.body.name;
		if (req.body.slug) {
			const newSlug = makeSlug(req.body.slug);
			if (db.projects.find(x => x.slug === newSlug && x.id !== p.id)) return res.status(409).json({ error: 'Slug already in use' });
			p.slug = newSlug;
		}
		saveData(db);
		logAudit(req.user, 'project.update', { projectId: p.id });
		res.json({ id: p.id, name: p.name, slug: p.slug });
	});

	app.delete('/api/v1/admin/projects/:projectId', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
		db.projects = db.projects.filter(p => p.id !== req.project.id);
		saveData(db);
		logAudit(req.user, 'project.delete', { projectId: req.project.id });
		res.json({ message: 'Deleted' });
	});

	// ═══════════════════════════════════════════════════════════════════
	//  ADMIN API — project-scoped resources
	// ═══════════════════════════════════════════════════════════════════

	// Stats
	app.get('/api/v1/admin/projects/:projectId/stats', authMiddleware, projectMiddleware, (req, res) => {
		const p = req.project;
		res.json({
			totalComponents: p.components.length,
			operationalComponents: p.components.filter(c => c.status === 'operational').length,
			activeIncidents: p.incidents.filter(i => i.status !== 'resolved' && i.status !== 'postmortem').length,
			scheduledMaintenances: (p.scheduledMaintenances || []).filter(m => m.status !== 'completed').length,
			totalSubscribers: p.subscribers.length
		});
	});

	// Component Groups
	// component-groups endpoints removed (groups deprecated)

	// Components
	app.get('/api/v1/admin/projects/:projectId/components', authMiddleware, projectMiddleware, (req, res) => {
		res.json(req.project.components.sort((a, b) => a.order - b.order));
	});

	app.post('/api/v1/admin/projects/:projectId/components', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
		const p = req.project;
		const { name, description, status, parentId } = req.body;
		if (!name) return res.status(400).json({ error: 'Name required' });
		const pid = parentId || null;
		const siblings = p.components.filter(c => (c.parentId || null) === pid);
		const nextOrder = siblings.length ? Math.max(...siblings.map(c => c.order || 0)) + 1 : 0;
		const comp = { id: nextId(), parentId: pid, name, description: description || '', status: status || 'operational', view: req.body.view || 'list', order: nextOrder, showUptime: true, createdAt: new Date().toISOString() };
		p.components.push(comp);
		const days = {}; const now = Date.now();
		for (let i = 0; i < 90; i++) days[new Date(now - i * 86400000).toISOString().slice(0, 10)] = 'operational';
		if (!p.uptimeData) p.uptimeData = {};
		p.uptimeData[comp.id] = days;
		saveData(db);
		logAudit(req.user, 'component.create', { projectId: p.id, componentId: comp.id });
		res.status(201).json(comp);
	});

	app.put('/api/v1/admin/projects/:projectId/components/:id', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
		const p = req.project;
		const comp = p.components.find(c => c.id === parseInt(req.params.id));
		if (!comp) return res.status(404).json({ error: 'Not found' });
		const oldStatus = comp.status;
		const incomingParent = ('parentId' in req.body) ? (req.body.parentId || null) : comp.parentId;
		const parentChanged = incomingParent !== (comp.parentId || null);
		Object.assign(comp, req.body, { id: comp.id, createdAt: comp.createdAt, parentId: incomingParent });
		if (parentChanged) {
			const siblings = p.components.filter(c => c.id !== comp.id && (c.parentId || null) === incomingParent);
			comp.order = siblings.length ? Math.max(...siblings.map(c => c.order || 0)) + 1 : 0;
		}
		if (comp.status !== oldStatus) {
			const today = new Date().toISOString().slice(0, 10);
			if (!p.uptimeData) p.uptimeData = {};
			if (!p.uptimeData[comp.id]) p.uptimeData[comp.id] = {};
			const sm = { operational: 'operational', degraded_performance: 'degraded_performance', partial_outage: 'degraded_performance', major_outage: 'major_outage', under_maintenance: 'operational' };
			p.uptimeData[comp.id][today] = sm[comp.status] || 'operational';
		}
		saveData(db);
		logAudit(req.user, 'component.update', { projectId: p.id, componentId: comp.id });
		res.json(comp);
	});

	app.post('/api/v1/admin/projects/:projectId/components/reorder', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
		const p = req.project;
		const parentId = req.body.parentId || null;
		const orderedIds = Array.isArray(req.body.orderedIds) ? req.body.orderedIds.map(id => parseInt(id)) : [];
		const siblings = p.components.filter(c => (c.parentId || null) === parentId);
		if (!siblings.length || !orderedIds.length) return res.json({ ok: true });
		const siblingIds = new Set(siblings.map(c => c.id));
		const normalized = orderedIds.filter(id => siblingIds.has(id));
		for (const c of siblings) {
			if (!normalized.includes(c.id)) normalized.push(c.id);
		}
		normalized.forEach((id, idx) => {
			const comp = p.components.find(c => c.id === id);
			if (comp) comp.order = idx;
		});
		saveData(db);
		logAudit(req.user, 'component.reorder', { projectId: p.id, parentId });
		res.json({ ok: true });
	});

	app.delete('/api/v1/admin/projects/:projectId/components/:id', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
		const p = req.project; const id = parseInt(req.params.id);
		p.components = p.components.filter(c => c.id !== id);
		if (p.uptimeData) delete p.uptimeData[id];
		saveData(db);
		logAudit(req.user, 'component.delete', { projectId: p.id, componentId: id });
		res.json({ message: 'Deleted' });
	});

	// Incidents
	app.get('/api/v1/admin/projects/:projectId/incidents', authMiddleware, projectMiddleware, (req, res) => {
		res.json(req.project.incidents.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
	});

	app.post('/api/v1/admin/projects/:projectId/incidents', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
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
		saveData(db);
		logAudit(req.user, 'incident.create', { projectId: p.id, incidentId: incident.id });
		res.status(201).json(incident);
	});

	app.post('/api/v1/admin/projects/:projectId/incidents/:id/updates', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
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
		saveData(db);
		logAudit(req.user, 'incident.update', { projectId: p.id, incidentId: incident.id });
		res.json(incident);
	});

	app.delete('/api/v1/admin/projects/:projectId/incidents/:id', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
		req.project.incidents = req.project.incidents.filter(i => i.id !== parseInt(req.params.id));
		saveData(db);
		logAudit(req.user, 'incident.delete', { projectId: req.project.id, incidentId: parseInt(req.params.id) });
		res.json({ message: 'Deleted' });
	});

	// Maintenances
	app.get('/api/v1/admin/projects/:projectId/maintenances', authMiddleware, projectMiddleware, (req, res) => {
		res.json((req.project.scheduledMaintenances || []).sort((a, b) => new Date(b.scheduledStart) - new Date(a.scheduledStart)));
	});

	app.post('/api/v1/admin/projects/:projectId/maintenances', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
		const p = req.project;
		const { title, message, scheduledStart, scheduledEnd, affectedComponents } = req.body;
		if (!title || !scheduledStart || !scheduledEnd) return res.status(400).json({ error: 'Title, start and end required' });
		if (!p.scheduledMaintenances) p.scheduledMaintenances = [];
		const maint = { id: nextId(), title, status: 'scheduled', message: message || '', scheduledStart, scheduledEnd, affectedComponents: affectedComponents || [], updates: [{ id: nextId(), status: 'scheduled', message: message || 'Scheduled maintenance', createdAt: new Date().toISOString() }], createdAt: new Date().toISOString() };
		p.scheduledMaintenances.push(maint);
		saveData(db);
		logAudit(req.user, 'maintenance.create', { projectId: p.id, maintenanceId: maint.id });
		res.status(201).json(maint);
	});

	app.put('/api/v1/admin/projects/:projectId/maintenances/:id', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
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
		saveData(db);
		logAudit(req.user, 'maintenance.update', { projectId: p.id, maintenanceId: maint.id });
		res.json(maint);
	});

	app.delete('/api/v1/admin/projects/:projectId/maintenances/:id', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
		req.project.scheduledMaintenances = (req.project.scheduledMaintenances || []).filter(m => m.id !== parseInt(req.params.id));
		saveData(db);
		logAudit(req.user, 'maintenance.delete', { projectId: req.project.id, maintenanceId: parseInt(req.params.id) });
		res.json({ message: 'Deleted' });
	});

	// Subscribers
	app.get('/api/v1/admin/projects/:projectId/subscribers', authMiddleware, projectMiddleware, (req, res) => {
		res.json(req.project.subscribers);
	});

	app.delete('/api/v1/admin/projects/:projectId/subscribers/:id', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
		req.project.subscribers = req.project.subscribers.filter(s => s.id !== parseInt(req.params.id));
		saveData(db);
		logAudit(req.user, 'subscriber.delete', { projectId: req.project.id, subscriberId: parseInt(req.params.id) });
		res.json({ message: 'Deleted' });
	});

	// Settings
	app.get('/api/v1/admin/projects/:projectId/settings', authMiddleware, projectMiddleware, (req, res) => {
		const settings = req.project.settings || {};
		const effectiveNotificationFromEmail = settings.notificationFromEmail || settings.supportEmail || '';
		res.json({
			...settings,
			effectiveNotificationFromEmail,
			customDomain: normalizeDomain(settings.customDomain || ''),
			redirectDomains: normalizeDomainList(settings.redirectDomains || [])
		});
	});

	app.get('/api/v1/admin/projects/:projectId/domain-config', authMiddleware, projectMiddleware, (req, res) => {
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

	app.post('/api/v1/admin/projects/:projectId/domain-validate', authMiddleware, projectMiddleware, async (req, res) => {
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
			const target = domain === cfg.primaryDomain
				? expectedTarget
				: (cfg.primaryDomain || expectedTarget);
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

	app.get('/api/v1/admin/projects/:projectId/analytics', authMiddleware, projectMiddleware, (req, res) => {
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

	app.get('/api/v1/admin/projects/:projectId/activity', authMiddleware, projectMiddleware, (req, res) => {
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

	app.put('/api/v1/admin/projects/:projectId/settings', authMiddleware, requireEditor, projectMiddleware, (req, res) => {
		if (!req.project.settings) req.project.settings = {};
		const incoming = req.body || {};
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
			const invalidRedirects = splitDomainInput(incoming.redirectDomains || []).filter((d) => {
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
		saveData(db);
		logAudit(req.user, 'settings.update', { projectId: req.project.id, fields: changedFields });
		const effectiveNotificationFromEmail = req.project.settings.notificationFromEmail || req.project.settings.supportEmail || '';
		res.json({
			...req.project.settings,
			effectiveNotificationFromEmail,
			customDomain: normalizeDomain(req.project.settings.customDomain || ''),
			redirectDomains: normalizeDomainList(req.project.settings.redirectDomains || [])
		});
	});

	// Users (global)
	app.get('/api/v1/admin/users', authMiddleware, requireAdmin, (_req, res) => {
		res.json(db.users.map(u => ({ id: u.id, username: u.username, email: u.email || u.username, name: u.name || '', role: u.role, createdAt: u.createdAt })));
	});

	app.post('/api/v1/admin/users', authMiddleware, requireAdmin, (req, res) => {
		const { name, email, password, role } = req.body || {};
		if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
		if (!password || password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters' });
		const username = email.toLowerCase();
		if (db.users.find(u => u.username === username || u.email === username)) return res.status(409).json({ error: 'User already exists' });
		const user = { id: nextId(), username, email: username, name: name || '', passwordHash: hashPassword(password), role: role || 'admin', createdAt: new Date().toISOString() };
		db.users.push(user);
		saveData(db);
		logAudit(req.user, 'user.create', { userId: user.id, email: user.email, role: user.role });
		res.status(201).json({ id: user.id, username: user.username, email: user.email, name: user.name || '', role: user.role, createdAt: user.createdAt });
	});

	app.put('/api/v1/admin/users/:id', authMiddleware, requireAdmin, (req, res) => {
		const user = db.users.find(u => u.id === parseInt(req.params.id));
		if (!user) return res.status(404).json({ error: 'Not found' });
		const { name, email, password, role } = req.body || {};
		if (email) {
			if (!email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
			const username = email.toLowerCase();
			if (db.users.find(u => (u.username === username || u.email === username) && u.id !== user.id)) return res.status(409).json({ error: 'Email already in use' });
			user.username = username;
			user.email = username;
		}
		if (name !== undefined) user.name = name;
		if (role) user.role = role;
		if (password) user.passwordHash = hashPassword(password);
		saveData(db);
		logAudit(req.user, 'user.update', { userId: user.id });
		res.json({ id: user.id, username: user.username, email: user.email, name: user.name || '', role: user.role, createdAt: user.createdAt });
	});

	app.delete('/api/v1/admin/users/:id', authMiddleware, requireAdmin, (req, res) => {
		const id = parseInt(req.params.id);
		if (req.user.id === id) return res.status(400).json({ error: 'Cannot delete self' });
		const target = db.users.find(u => u.id === id);
		if (!target) return res.status(404).json({ error: 'Not found' });
		const admins = db.users.filter(u => u.role === 'admin');
		if (target.role === 'admin' && admins.length <= 1) return res.status(400).json({ error: 'Cannot delete last admin' });
		db.users = db.users.filter(u => u.id !== id);
		saveData(db);
		logAudit(req.user, 'user.delete', { userId: id });
		res.json({ message: 'Deleted' });
	});

	// ═══════════════════════════════════════════════════════════════════
	//  HEALTH & LEGACY
	// ═══════════════════════════════════════════════════════════════════

	app.get('/api/health', (_req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));
	app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

	// Legacy compat — uses first project
	app.get('/api/services', (_req, res) => res.json(db.projects[0] ? db.projects[0].components : []));
	app.get('/api/metrics', (req, res) => {
		const timespan = req.query.timespan || '7d';
		const days = Math.max(1, parseInt(('' + timespan).replace(/\D/g, '') || '7', 10));
		const data = Array.from({ length: days }, (_, i) => ({ date: new Date(Date.now() - (days - 1 - i) * 86400000).toISOString(), value: Math.round(10 + Math.random() * 90) }));
		res.json({ data });
	});

	app.get('/favicon.ico', (_req, res) => res.status(204).end());

	// Serve /p/:slug → index.html (public page reads slug from URL)
	app.get('/p/:slug', (req, res) => {
		const project = getProjectBySlug(req.params.slug);
		if (project) trackProjectPageView(project, req);
		res.setHeader('Cache-Control', 'no-store');
		res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
	});

	// SPA fallback
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

} catch (err) {
	console.error('Express not available, using native HTTP fallback');
	const http = require('http');
	const { URL } = require('url');

	app = async function handler(req, res) {
		applySecurityHeaders(res);
		const origin = req.headers.origin;
		const allowed = isOriginAllowed(req, origin);
		applyCorsHeaders(req, res);
		if (origin && !allowed) {
			if (req.method === 'OPTIONS') { res.writeHead(403); return res.end(); }
			res.writeHead(403, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ error: 'Origin not allowed' }));
		}
		if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
		const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
		const pathname = url.pathname;
		const json = (res, data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
		const authenticatedUser = verifyToken(tokenFromRequest(req));
		const requireFallbackRole = (roles) => {
			if (!authenticatedUser) {
				json(res, { error: 'Unauthorized' }, 401);
				return null;
			}
			if (!roles.includes(authenticatedUser.role)) {
				json(res, { error: 'Forbidden' }, 403);
				return null;
			}
			return authenticatedUser;
		};
		const hostMatch = resolveProjectByHost(req.headers.host);
		if (hostMatch && hostMatch.redirect && hostMatch.targetDomain) {
			res.writeHead(308, { Location: buildRedirectUrl(req, hostMatch.targetDomain) });
			return res.end();
		}

		if (req.method === 'GET' && pathname === '/api/health') return json(res, { status: 'healthy' });
		if (req.method === 'GET' && pathname === '/api/v1/projects') return json(res, db.projects.map(p => ({ id: p.id, name: p.name, slug: p.slug })));
		if (req.method === 'GET' && pathname === '/api/v1/project-context') {
			const project = hostMatch ? hostMatch.project : db.projects[0];
			if (!project) return json(res, { error: 'No projects found' }, 404);
			const cfg = getProjectDomainConfig(project);
			return json(res, { id: project.id, name: project.name, slug: project.slug, customDomain: cfg.primaryDomain, redirectDomains: cfg.redirectDomains, source: hostMatch ? 'host' : 'default' });
		}

		if (req.method === 'POST' && pathname === '/api/v1/auth/login') {
			let body = '';
			req.on('data', (chunk) => { body += chunk; });
			req.on('end', () => {
				try {
					const payload = body ? JSON.parse(body) : {};
					const username = String(payload.username || '').trim().toLowerCase();
					const password = String(payload.password || '');
					const rate = consumeLoginRateLimit(req, username);
					if (!rate.allowed) return json(res, { error: 'Too many login attempts. Please try again later.' }, 429);
					if (!Array.isArray(db.users) || db.users.length === 0) {
						return json(res, { error: 'No users configured. Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD, then restart.' }, 503);
					}
					const user = db.users.find(u => (u.username === username || u.email === username));
					if (!user || !verifyPassword(password, user.passwordHash)) return json(res, { error: 'Invalid credentials' }, 401);
					if (shouldRehashPassword(user.passwordHash)) {
						user.passwordHash = hashPassword(password);
						saveData(db);
					}
					resetLoginRateLimit(rate.key);
					const token = createToken({ id: user.id, username: user.username, role: user.role });
					setAuthCookieHeader(req, res, token);
					logAudit(user, 'auth.login', {});
					return json(res, { user: { id: user.id, username: user.username, role: user.role } }, 200);
				} catch {
					return json(res, { error: 'Invalid JSON' }, 400);
				}
			});
			return;
		}
		if (req.method === 'GET' && pathname === '/api/v1/auth/me') {
			if (!authenticatedUser) return json(res, { error: 'Unauthorized' }, 401);
			return json(res, authenticatedUser);
		}
		if (req.method === 'POST' && pathname === '/api/v1/auth/logout') {
			clearAuthCookieHeader(req, res);
			res.writeHead(204);
			return res.end();
		}

		// Admin users
		if (pathname === '/api/v1/admin/users' && req.method === 'GET') {
			const user = requireFallbackRole(['admin']);
			if (!user) return;
			return json(res, db.users.map(u => ({ id: u.id, username: u.username, email: u.email || u.username, name: u.name || '', role: u.role, createdAt: u.createdAt })));
		}
		if (pathname === '/api/v1/admin/users' && req.method === 'POST') {
			const actor = requireFallbackRole(['admin']);
			if (!actor) return;
			let body = '';
			req.on('data', (chunk) => { body += chunk; });
			req.on('end', () => {
				try {
					const { name, email, password, role } = body ? JSON.parse(body) : {};
					if (!email || !email.includes('@')) return json(res, { error: 'Valid email required' }, 400);
					if (!password || password.length < 12) return json(res, { error: 'Password must be at least 12 characters' }, 400);
					const username = email.toLowerCase();
					if (db.users.find(u => u.username === username || u.email === username)) return json(res, { error: 'User already exists' }, 409);
					const user = { id: nextId(), username, email: username, name: name || '', passwordHash: hashPassword(password), role: role || 'admin', createdAt: new Date().toISOString() };
					db.users.push(user);
					saveData(db);
					logAudit(actor, 'user.create', { userId: user.id, email: user.email, role: user.role });
					return json(res, { id: user.id, username: user.username, email: user.email, name: user.name || '', role: user.role, createdAt: user.createdAt }, 201);
				} catch {
					return json(res, { error: 'Invalid JSON' }, 400);
				}
			});
			return;
		}
		const adminUserMatch = pathname.match(/^\/api\/v1\/admin\/users\/(\d+)$/);
		if (adminUserMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
			const actor = requireFallbackRole(['admin']);
			if (!actor) return;
			const user = db.users.find(u => u.id === parseInt(adminUserMatch[1]));
			if (!user) return json(res, { error: 'Not found' }, 404);
			if (req.method === 'DELETE') {
				if (actor.id === user.id) return json(res, { error: 'Cannot delete self' }, 400);
				const admins = db.users.filter(u => u.role === 'admin');
				if (user.role === 'admin' && admins.length <= 1) return json(res, { error: 'Cannot delete last admin' }, 400);
				db.users = db.users.filter(u => u.id !== user.id);
				saveData(db);
				logAudit(actor, 'user.delete', { userId: user.id });
				return json(res, { message: 'Deleted' });
			}
			let body = '';
			req.on('data', (chunk) => { body += chunk; });
			req.on('end', () => {
				try {
					const { name, email, password, role } = body ? JSON.parse(body) : {};
					if (email) {
						if (!email.includes('@')) return json(res, { error: 'Valid email required' }, 400);
						const username = email.toLowerCase();
						if (db.users.find(u => (u.username === username || u.email === username) && u.id !== user.id)) return json(res, { error: 'Email already in use' }, 409);
						user.username = username;
						user.email = username;
					}
					if (name !== undefined) user.name = name;
					if (role) user.role = role;
					if (password) user.passwordHash = hashPassword(password);
					saveData(db);
					logAudit(actor, 'user.update', { userId: user.id });
					return json(res, { id: user.id, username: user.username, email: user.email, name: user.name || '', role: user.role, createdAt: user.createdAt });
				} catch {
					return json(res, { error: 'Invalid JSON' }, 400);
				}
			});
			return;
		}

		// Match /api/v1/projects/:slug/...
		const m = pathname.match(/^\/api\/v1\/projects\/([^/]+)\/(.+)$/);
		if (m) {
			const proj = getProjectBySlug(m[1]);
			if (!proj) return json(res, { error: 'Project not found' }, 404);
			const sub = m[2];
			if (req.method === 'GET' && sub === 'status') {
				return json(res, { status: computeOverallStatus(proj.components), updatedAt: new Date().toISOString() });
			}
			if (req.method === 'GET' && sub === 'components') {
				return json(res, { components: (proj.components || []).sort((a, b) => a.order - b.order) });
			}
			if (req.method === 'GET' && sub === 'incidents') return json(res, proj.incidents || []);
			if (req.method === 'GET' && sub === 'uptime') return json(res, proj.uptimeData || {});
			if (req.method === 'GET' && sub === 'scheduled-maintenances') return json(res, proj.scheduledMaintenances || []);
			if (req.method === 'GET' && sub === 'settings') return json(res, getPublicProjectSettings(proj));
			if (req.method === 'GET' && sub === 'public-snapshot') return json(res, getPublicProjectSnapshot(proj));
		}

		const adminMatch = pathname.match(/^\/api\/v1\/admin\/projects\/(\d+)\/components\/reorder$/);
		if (adminMatch && req.method === 'POST') {
			const actor = requireFallbackRole(['admin', 'editor']);
			if (!actor) return;
			const proj = getProjectById(adminMatch[1]);
			if (!proj) return json(res, { error: 'Project not found' }, 404);
			let body = '';
			req.on('data', (chunk) => { body += chunk; });
			req.on('end', () => {
				try {
					const payload = body ? JSON.parse(body) : {};
					const parentId = payload.parentId || null;
					const orderedIds = Array.isArray(payload.orderedIds) ? payload.orderedIds.map(id => parseInt(id)) : [];
					const siblings = (proj.components || []).filter(c => (c.parentId || null) === parentId);
					if (!siblings.length || !orderedIds.length) return json(res, { ok: true });
					const siblingIds = new Set(siblings.map(c => c.id));
					const normalized = orderedIds.filter(id => siblingIds.has(id));
					for (const c of siblings) {
						if (!normalized.includes(c.id)) normalized.push(c.id);
					}
					normalized.forEach((id, idx) => {
						const comp = proj.components.find(c => c.id === id);
						if (comp) comp.order = idx;
					});
					saveData(db);
					logAudit(actor, 'component.reorder', { projectId: proj.id, parentId });
					return json(res, { ok: true });
				} catch {
					return json(res, { error: 'Invalid JSON' }, 400);
				}
			});
			return;
		}

		if (pathname.startsWith('/p/')) {
			const parts = pathname.split('/');
			const slug = parts[2] || '';
			const project = getProjectBySlug(slug);
			if (project) trackProjectPageView(project, req);
		} else if ((pathname === '/' || pathname === '/index.html') && hostMatch && hostMatch.project) {
			trackProjectPageView(hostMatch.project, req);
		}
		let filePath = safePublicPath(pathname === '/' || pathname.startsWith('/p/') ? '/index.html' : pathname);
		if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
			const ext = path.extname(filePath);
			const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
			res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
			return res.end(fs.readFileSync(filePath));
		}
		filePath = path.join(PUBLIC_DIR, 'index.html');
		if (fs.existsSync(filePath)) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(filePath)); }
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not found' }));
	};
}

module.exports = app;

if (require.main === module) {
	const port = parseInt(process.env.PORT || '3000', 10);
	if (usingExpress) {
		const server = app.listen(port, () => console.log(`✓ Status page running at http://localhost:${port}`));
		server.on('error', (err) => { if (err.code === 'EADDRINUSE') { console.error(`Port ${port} in use`); process.exit(1); } console.error('Server error:', err); process.exit(1); });
	} else {
		const http = require('http');
		const server = http.createServer(app);
		server.listen(port, () => console.log(`✓ Status page (native) running at http://localhost:${port}`));
	}
}
