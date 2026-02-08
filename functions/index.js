const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');
const { onRequest } = require('firebase-functions/v2/https');

admin.initializeApp();

const firestore = admin.firestore();
const stateRef = firestore.collection('statusPage').doc('main');
const auditRef = stateRef.collection('audit');
const firestoreSyncEnabled = Boolean(
	process.env.FIRESTORE_EMULATOR_HOST ||
	process.env.GCLOUD_PROJECT ||
	process.env.GOOGLE_CLOUD_PROJECT ||
	process.env.FIREBASE_CONFIG
);

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
			await stateRef.set(parsed, { merge: false });
		});
	};

	fs.appendFileSync = function patchedAppend(filePath, data, ...rest) {
		originalAppend(filePath, data, ...rest);
		if (path.resolve(String(filePath)) !== LOG_PATH) return;
		const entries = parseAuditLines(data);
		if (entries.length === 0) return;
		enqueueSync(async () => {
			const batch = firestore.batch();
			for (const entry of entries) {
				const doc = auditRef.doc();
				batch.set(doc, entry);
			}
			await batch.commit();
		});
	};
}

async function hydrateLocalFilesFromFirestore() {
	if (!firestoreSyncEnabled) {
		logger.info('Firestore sync disabled (no Firebase project/emulator context detected). Using local files only.');
		return;
	}
	try {
		const snap = await stateRef.get();
		if (snap.exists) {
			fs.writeFileSync(DATA_FILE, JSON.stringify(snap.data(), null, 2), 'utf-8');
			logger.info('Loaded app state from Firestore.');
		}
	} catch (err) {
		logger.warn('Unable to load app state from Firestore. Falling back to local data.json.', err.message);
	}

	try {
		const audits = await auditRef.orderBy('at', 'asc').limit(5000).get();
		if (!audits.empty) {
			const lines = audits.docs.map((d) => JSON.stringify(d.data()));
			fs.writeFileSync(LOG_FILE, lines.join('\n') + '\n', 'utf-8');
		}
	} catch (err) {
		logger.warn('Unable to load audit entries from Firestore. Continuing with local audit.log.', err.message);
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
