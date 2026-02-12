'use strict';

const path = require('path');
const net = require('net');
const { PUBLIC_DIR, ALLOWED_DISABLED_TABS } = require('./constants');

function makeSlug(name) {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
	return labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function isValidEmail(value) {
	if (!value || typeof value !== 'string') return false;
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
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

function appendVary(existing, value) {
	if (!existing) return value;
	const parts = String(existing).split(',').map(v => v.trim()).filter(Boolean);
	if (!parts.includes(value)) parts.push(value);
	return parts.join(', ');
}

function sanitizeDisabledTabs(input) {
	if (!input || typeof input !== 'object') return {};
	const out = {};
	for (const key of ALLOWED_DISABLED_TABS) {
		if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = !!input[key];
	}
	return out;
}

function getDateKey(dateValue) {
	const d = dateValue ? new Date(dateValue) : new Date();
	return d.toISOString().slice(0, 10);
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

module.exports = {
	makeSlug,
	normalizeDomain,
	splitDomainInput,
	normalizeDomainList,
	isValidDomainHost,
	isValidEmail,
	parseCookies,
	appendVary,
	sanitizeDisabledTabs,
	getDateKey,
	safePublicPath
};
