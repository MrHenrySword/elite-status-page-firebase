'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { BCRYPT_ROUNDS, PASSWORD_MIGRATION_VERSION } = require('./constants');
const { isValidEmail } = require('./helpers');

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
	try { return bcrypt.getRounds(hash) < BCRYPT_ROUNDS; } catch { return true; }
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
	if (seeded.length > 0) data.users = seeded;
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

module.exports = {
	legacyHashPassword,
	hashPassword,
	isLegacyPasswordHash,
	verifyPassword,
	shouldRehashPassword,
	buildInitialUsers,
	ensureInitialUsers,
	migrateLegacyPasswordHashes
};
