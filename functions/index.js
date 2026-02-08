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
const COL_AUDIT = 'status_audit';
const META_DOC_ID = 'main';

const DATA_FILE = path.join(__dirname, 'data.json');
const LOG_FILE = path.join(__dirname, 'audit.log');
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
		platformSettings: safe.platformSettings || {},
		securityMigrations: safe.securityMigrations || {},
		updatedAt: new Date().toISOString(),
		schemaVersion: 1
	};

	await firestore.collection(COL_META).doc(META_DOC_ID).set(metaPayload, { merge: false });
	await upsertCollectionById(COL_USERS, users);
	await upsertCollectionById(COL_PROJECTS, projects);
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
		platformSettings: meta.platformSettings || {},
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

const appPromise = (async () => {
	await hydrateLocalFilesFromFirestore();
	patchFsForFirestoreSync();
	return require('./server');
})();

exports.api = onRequest(
	{
		region: process.env.FUNCTION_REGION || 'us-central1',
		memory: '512MiB',
		timeoutSeconds: 60
	},
	async (req, res) => {
		const app = await appPromise;
		return app(req, res);
	}
);
