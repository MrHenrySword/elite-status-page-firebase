'use strict';

const dns = require('dns').promises;
const { normalizeDomain, isValidDomainHost } = require('../lib/helpers');

function getExpectedDnsTarget(hostHeader) {
	return normalizeDomain(process.env.CUSTOM_DOMAIN_TARGET || process.env.WEBSITE_HOSTNAME || hostHeader || '');
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

module.exports = { getExpectedDnsTarget, requestProtocol, buildRedirectUrl, resolveDnsSafe, validateDomainDns };
