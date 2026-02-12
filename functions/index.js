const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');
const { onRequest } = require('firebase-functions/v2/https');

admin.initializeApp();

const firestore = admin.firestore();
const firestoreSyncEnabled = Boolean(
	process.env.FIRESTORE_EMULATOR_HOST ||
	process.env.GCLOUD_PROJECT ||
	process.env.GOOGLE_CLOUD_PROJECT ||
	process.env.FIREBASE_CONFIG
);

const COL_META = 'status_meta';
const COL_USERS = 'status_users';
const COL_PROJECTS = 'status_projects';
const COL_PUBLIC_PROJECTS = 'status_public_projects';
const COL_AUDIT = 'status_audit';
const META_DOC_ID = 'main';

const isCloudFunctions = !!process.env.K_SERVICE || !!process.env.FUNCTION_TARGET;
const dataDir = isCloudFunctions ? '/tmp' : __dirname;
const DATA_FILE = path.join(dataDir, 'data.json');
const LOG_FILE = path.join(dataDir, 'audit.log');
const DATA_PATH = path.resolve(DATA_FILE);
const LOG_PATH = path.resolve(LOG_FILE);

let fsPatched = false;
let syncQueue = Promise.resolve();

function enqueueSync(task) {
	if (!firestoreSyncEnabled) return Promise.resolve();
	syncQueue = syncQueue
		.then(task)
		.catch((err) => logger.error('Firestore sync failed', err));
	return syncQueue;
}

function toText(input) {
	return Buffer.isBuffer(input) ? input.toString('utf-8') : String(input);
}

function parseAuditLines(text) {
	return toText(text)
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			try { return JSON.parse(line); } catch { return null; }
		})
		.filter(Boolean);
}

function byNumericId(a, b) {
	return (Number(a.id) || 0) - (Number(b.id) || 0);
}

function normalizeDomain(value) {
	if (!value || typeof value !== 'string') return '';
	let input = value.trim().toLowerCase();
	if (!input) return '';
	if (!input.includes('://')) input = 'http://' + input;
	try {
		return new URL(input).hostname.toLowerCase().replace(/\.+$/, '');
	} catch {
		return '';
	}
}

function splitDomainInput(value) {
	const raw = Array.isArray(value) ? value.join(',') : String(value || '');
	return raw.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);
}

function normalizeDomainList(value) {
	const parts = splitDomainInput(value).map(normalizeDomain).filter(Boolean);
	return [...new Set(parts)];
}

function sortByOrderThenId(a, b) {
	const aOrder = Number.isFinite(Number(a && a.order)) ? Number(a.order) : Number.MAX_SAFE_INTEGER;
	const bOrder = Number.isFinite(Number(b && b.order)) ? Number(b.order) : Number.MAX_SAFE_INTEGER;
	if (aOrder !== bOrder) return aOrder - bOrder;
	return (Number(a && a.id) || 0) - (Number(b && b.id) || 0);
}

function normalizePublicSettings(input) {
	const settings = input && typeof input === 'object' ? input : {};
	const customDomain = normalizeDomain(settings.customDomain || '');
	const redirectDomains = normalizeDomainList(settings.redirectDomains || []).filter((d) => d !== customDomain);

	return {
		pageTitle: settings.pageTitle || '',
		pageName: settings.pageName || '',
		organizationLegalName: settings.organizationLegalName || '',
		companyName: settings.companyName || '',
		companyUrl: settings.companyUrl || '',
		supportUrl: settings.supportUrl || '',
		privacyPolicyUrl: settings.privacyPolicyUrl || '',
		statusPageLogoUrl: settings.statusPageLogoUrl || '',
		adminPanelLogoUrl: settings.adminPanelLogoUrl || '',
		displayMode: settings.displayMode || 'single',
		secondaryProjectId: settings.secondaryProjectId || null,
		tertiaryProjectId: settings.tertiaryProjectId || null,
		defaultSmsCountryCode: settings.defaultSmsCountryCode || '+1',
		timezone: settings.timezone || 'UTC',
		googleAnalyticsTrackingId: settings.googleAnalyticsTrackingId || '',
		hideFromSearchEngines: !!settings.hideFromSearchEngines,
		brandColor: settings.brandColor || '#0052cc',
		aboutText: settings.aboutText || '',
		componentsView: settings.componentsView || 'list',
		showUptime: settings.showUptime !== false,
		disabledTabs: (settings.disabledTabs && typeof settings.disabledTabs === 'object') ? settings.disabledTabs : {},
		customDomain,
		redirectDomains
	};
}

function sanitizePublicProject(project) {
	const safe = project && typeof project === 'object' ? project : {};
	const settings = normalizePublicSettings(safe.settings);
	const nowIso = new Date().toISOString();

	const components = Array.isArray(safe.components)
		? safe.components.map((c) => ({
			id: c.id,
			parentId: c.parentId || null,
			name: c.name || '',
			description: c.description || '',
			status: c.status || 'operational',
			order: Number.isFinite(Number(c.order)) ? Number(c.order) : 0,
			showUptime: c.showUptime !== false,
			createdAt: c.createdAt || nowIso
		})).sort(sortByOrderThenId)
		: [];

	const incidents = Array.isArray(safe.incidents)
		? safe.incidents.map((incident) => ({
			...incident,
			updates: Array.isArray(incident.updates) ? incident.updates : []
		})).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
		: [];

	const scheduledMaintenances = Array.isArray(safe.scheduledMaintenances)
		? safe.scheduledMaintenances.map((maintenance) => ({
			...maintenance,
			updates: Array.isArray(maintenance.updates) ? maintenance.updates : []
		})).sort((a, b) => new Date(a.scheduledStart || 0) - new Date(b.scheduledStart || 0))
		: [];

	const uptimeData = safe.uptimeData && typeof safe.uptimeData === 'object' ? safe.uptimeData : {};

	return {
		id: safe.id,
		name: safe.name || '',
		slug: safe.slug || '',
		customDomain: settings.customDomain,
		redirectDomains: settings.redirectDomains,
		settings,
		components,
		incidents,
		scheduledMaintenances,
		uptimeData,
		updatedAt: nowIso,
		schemaVersion: 1
	};
}

async function commitOps(ops) {
	if (!ops.length) return;
	const chunkSize = 400;
	for (let i = 0; i < ops.length; i += chunkSize) {
		const batch = firestore.batch();
		for (const op of ops.slice(i, i + chunkSize)) {
			if (op.type === 'set') batch.set(op.ref, op.data, { merge: false });
			else if (op.type === 'delete') batch.delete(op.ref);
		}
		await batch.commit();
	}
}

async function upsertCollectionById(collectionName, items) {
	const collRef = firestore.collection(collectionName);
	const snap = await collRef.get();
	const existing = new Set(snap.docs.map((d) => d.id));
	const nextIds = new Set();
	const ops = [];

	for (const item of items) {
		const id = String(item && item.id);
		if (!id || id === 'undefined' || id === 'null') continue;
		nextIds.add(id);
		ops.push({ type: 'set', ref: collRef.doc(id), data: item });
	}
	for (const id of existing) {
		if (!nextIds.has(id)) ops.push({ type: 'delete', ref: collRef.doc(id) });
	}
	await commitOps(ops);
}

async function persistDataToCollections(data) {
	const safe = data && typeof data === 'object' ? data : {};
	const users = Array.isArray(safe.users) ? safe.users : [];
	const projects = Array.isArray(safe.projects) ? safe.projects : [];
	const metaPayload = {
		nextId: safe.nextId || 2000,
		securityMigrations: safe.securityMigrations || {},
		updatedAt: new Date().toISOString(),
		schemaVersion: 1
	};

	await firestore.collection(COL_META).doc(META_DOC_ID).set(metaPayload, { merge: false });
	await upsertCollectionById(COL_USERS, users);
	await upsertCollectionById(COL_PROJECTS, projects);
	await upsertCollectionById(COL_PUBLIC_PROJECTS, projects.map(sanitizePublicProject));
}

async function loadDataFromCollections() {
	const metaSnap = await firestore.collection(COL_META).doc(META_DOC_ID).get();
	const usersSnap = await firestore.collection(COL_USERS).get();
	const projectsSnap = await firestore.collection(COL_PROJECTS).get();

	const users = usersSnap.docs.map((d) => d.data()).sort(byNumericId);
	const projects = projectsSnap.docs.map((d) => d.data()).sort(byNumericId);
	const hasCollectionsData = !!metaSnap.exists || users.length > 0 || projects.length > 0;
	if (!hasCollectionsData) return null;

	const meta = metaSnap.exists ? metaSnap.data() : {};
	return {
		users,
		projects,
		nextId: meta.nextId || 2000,
		securityMigrations: meta.securityMigrations || {}
	};
}

async function loadAuditFromCollection(limit = 5000) {
	const snap = await firestore.collection(COL_AUDIT).orderBy('at', 'asc').limit(limit).get();
	return snap.docs.map((d) => d.data());
}

function patchFsForFirestoreSync() {
	if (fsPatched) return;
	fsPatched = true;

	const originalWrite = fs.writeFileSync.bind(fs);
	const originalAppend = fs.appendFileSync.bind(fs);

	fs.writeFileSync = function patchedWrite(filePath, data, ...rest) {
		originalWrite(filePath, data, ...rest);
		if (path.resolve(String(filePath)) !== DATA_PATH) return;
		const text = toText(data);
		enqueueSync(async () => {
			const parsed = JSON.parse(text);
			await persistDataToCollections(parsed);
		});
	};

	fs.appendFileSync = function patchedAppend(filePath, data, ...rest) {
		originalAppend(filePath, data, ...rest);
		if (path.resolve(String(filePath)) !== LOG_PATH) return;
		const entries = parseAuditLines(data);
		if (entries.length === 0) return;
		enqueueSync(async () => {
			const ops = entries.map((entry) => ({
				type: 'set',
				ref: firestore.collection(COL_AUDIT).doc(),
				data: entry
			}));
			await commitOps(ops);
		});
	};
}

async function hydrateLocalFilesFromFirestore() {
	if (!firestoreSyncEnabled) {
		logger.info('Firestore sync disabled (no Firebase project/emulator context detected). Using local files only.');
		return;
	}

	try {
		const state = await loadDataFromCollections();
		if (state) {
			fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf-8');
			logger.info('Loaded app state from Firestore collections.');
		}
	} catch (err) {
		logger.warn('Unable to load app state from Firestore collections. Falling back to local data.json.', err.message);
	}

	try {
		const entries = await loadAuditFromCollection(5000);
		if (entries.length > 0) {
			const lines = entries.map((entry) => JSON.stringify(entry));
			fs.writeFileSync(LOG_FILE, lines.join('\n') + '\n', 'utf-8');
			logger.info('Loaded audit entries from Firestore collection.');
		}
	} catch (err) {
		logger.warn('Unable to load audit entries from Firestore collection. Continuing with local audit.log.', err.message);
	}
}

async function bootstrapFirestoreCollectionsIfNeeded() {
	if (!firestoreSyncEnabled) return;

	try {
		const [metaSnap, publicSnap] = await Promise.all([
			firestore.collection(COL_META).doc(META_DOC_ID).get(),
			firestore.collection(COL_PUBLIC_PROJECTS).limit(1).get()
		]);

		// If core data and public projections are already present, skip bootstrap writes.
		if (metaSnap.exists && !publicSnap.empty) return;

		if (!fs.existsSync(DATA_FILE)) return;
		const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
		await persistDataToCollections(parsed);
		logger.info('Bootstrapped Firestore collections from local data.json.');
	} catch (err) {
		logger.warn('Unable to bootstrap Firestore collections from local data.', err.message);
	}
}

let appPromise;
function getApp() {
	if (!appPromise) {
		appPromise = (async () => {
			await hydrateLocalFilesFromFirestore();
			await bootstrapFirestoreCollectionsIfNeeded();
			patchFsForFirestoreSync();
			return require('./server');
		})();
	}
	return appPromise;
}

exports.api = onRequest(
	{
		region: process.env.API_REGION || 'us-central1',
		memory: '512MiB',
		timeoutSeconds: 60
	},
	async (req, res) => {
		const app = await getApp();
		return app(req, res);
	}
);
