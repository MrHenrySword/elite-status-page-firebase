let PROJECT_SLUG = '';
let API_BASE = '';
let PROJECT_SOURCE = 'path';
let PUBLIC_SNAPSHOT = null;
let DATA_SOURCE = 'api';
let firebaseInitPromise = null;
let firebaseHostingRuntimePromise = null;
let firestoreUnsubscribe = null;

const FIREBASE_SCRIPT_VERSION = '10.12.5';
const PUBLIC_PROJECT_COLLECTION = 'status_public_projects';
const scriptLoadCache = {};

const pathMatch = window.location.pathname.match(/^\/p\/([^/]+)/);
if (pathMatch) {
    PROJECT_SLUG = decodeURIComponent(pathMatch[1]);
    PROJECT_SOURCE = 'path';
}

function updateApiBase() {
    API_BASE = PROJECT_SLUG ? '/api/v1/projects/' + PROJECT_SLUG : '';
}

updateApiBase();

function normalizeDomainHost(value) {
    const raw = String(value || '').trim().toLowerCase();
    return raw.replace(/\.+$/, '');
}

function isLocalHost(host) {
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function shouldRewritePathToProjectSlug(source) {
    if (!PROJECT_SLUG) return false;
    if (source !== 'default') return false;
    const p = window.location.pathname;
    return p === '/' || p === '/index.html';
}

function maybeRewritePathToProjectSlug(source) {
    if (!shouldRewritePathToProjectSlug(source)) return;
    history.replaceState(null, '', '/p/' + encodeURIComponent(PROJECT_SLUG));
}

function computeOverallStatus(components) {
    const list = Array.isArray(components) ? components : [];
    if (list.some((c) => c.status === 'major_outage')) return 'major_outage';
    if (list.some((c) => c.status === 'partial_outage')) return 'partial_outage';
    if (list.some((c) => c.status === 'degraded_performance')) return 'degraded_performance';
    if (list.some((c) => c.status === 'under_maintenance')) return 'under_maintenance';
    return 'operational';
}

function normalizePublicSnapshot(snapshot) {
    const safe = snapshot && typeof snapshot === 'object' ? snapshot : {};
    return {
        id: safe.id || null,
        slug: String(safe.slug || ''),
        name: String(safe.name || ''),
        settings: (safe.settings && typeof safe.settings === 'object') ? safe.settings : {},
        components: Array.isArray(safe.components) ? safe.components : [],
        incidents: Array.isArray(safe.incidents) ? safe.incidents : [],
        scheduledMaintenances: Array.isArray(safe.scheduledMaintenances) ? safe.scheduledMaintenances : [],
        uptimeData: (safe.uptimeData && typeof safe.uptimeData === 'object') ? safe.uptimeData : {},
        customDomain: String(safe.customDomain || ''),
        redirectDomains: Array.isArray(safe.redirectDomains) ? safe.redirectDomains : [],
        updatedAt: safe.updatedAt || new Date().toISOString()
    };
}

function getLocalSnapshotResponse(url) {
    if (!PUBLIC_SNAPSHOT) return null;

    if (url === '/status') {
        return {
            status: computeOverallStatus(PUBLIC_SNAPSHOT.components),
            updatedAt: PUBLIC_SNAPSHOT.updatedAt || new Date().toISOString()
        };
    }

    if (url === '/settings') return PUBLIC_SNAPSHOT.settings || {};

    if (url === '/components') {
        const components = [...(PUBLIC_SNAPSHOT.components || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
        return { components };
    }

    if (url === '/incidents') {
        return [...(PUBLIC_SNAPSHOT.incidents || [])].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    }

    if (url === '/incidents?status=active') {
        return [...(PUBLIC_SNAPSHOT.incidents || [])]
            .filter((incident) => incident.status !== 'resolved' && incident.status !== 'postmortem')
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    }

    if (url === '/scheduled-maintenances') {
        const now = Date.now();
        return [...(PUBLIC_SNAPSHOT.scheduledMaintenances || [])]
            .filter((maintenance) => new Date(maintenance.scheduledEnd || 0).getTime() > now || maintenance.status !== 'completed')
            .sort((a, b) => new Date(a.scheduledStart || 0) - new Date(b.scheduledStart || 0));
    }

    if (url === '/uptime') return PUBLIC_SNAPSHOT.uptimeData || {};

    return null;
}

async function fetchJSON(url) {
    const local = getLocalSnapshotResponse(url);
    if (local !== null) return local;

    const full = API_BASE ? API_BASE + url : url;
    const r = await fetch(full, { credentials: 'same-origin' });
    return r.json();
}

async function resolveProjectViaApi() {
    if (PROJECT_SLUG) {
        updateApiBase();
        return;
    }

    try {
        const ctxRes = await fetch('/api/v1/project-context');
        const ctxType = ctxRes.headers.get('content-type') || '';
        if (ctxType.includes('application/json')) {
            const ctx = await ctxRes.json();
            if (ctx && ctx.slug) {
                PROJECT_SLUG = ctx.slug;
                PROJECT_SOURCE = ctx.source || 'default';
                updateApiBase();
                maybeRewritePathToProjectSlug(PROJECT_SOURCE);
                return;
            }
        }
    } catch (e) {}

    try {
        const res = await fetch('/api/v1/projects');
        const type = res.headers.get('content-type') || '';
        if (!type.includes('application/json')) {
            if (window.location.port !== '3000') {
                const retry = await fetch('http://localhost:3000/api/v1/projects');
                const retryType = retry.headers.get('content-type') || '';
                if (retryType.includes('application/json')) {
                    const list = await retry.json();
                    if (!list || list.length === 0) return;
                    PROJECT_SLUG = list[0].slug;
                    PROJECT_SOURCE = 'default';
                    API_BASE = 'http://localhost:3000/api/v1/projects/' + PROJECT_SLUG;
                    maybeRewritePathToProjectSlug(PROJECT_SOURCE);
                    return;
                }
            }
            throw new Error('Non-JSON response');
        }

        const list = await res.json();
        if (!list || list.length === 0) return;
        PROJECT_SLUG = list[0].slug;
        PROJECT_SOURCE = 'default';
        updateApiBase();
        maybeRewritePathToProjectSlug(PROJECT_SOURCE);
    } catch (e) {}
}

function loadScriptOnce(src) {
    if (scriptLoadCache[src]) return scriptLoadCache[src];
    scriptLoadCache[src] = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${src}"]`);
        if (existing) {
            if (existing.dataset.loaded === 'true') {
                resolve();
            } else {
                existing.addEventListener('load', () => resolve(), { once: true });
                existing.addEventListener('error', () => reject(new Error('Failed to load: ' + src)), { once: true });
            }
            return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.dataset.loaded = 'false';
        script.onload = () => {
            script.dataset.loaded = 'true';
            resolve();
        };
        script.onerror = () => reject(new Error('Failed to load: ' + src));
        document.head.appendChild(script);
    });
    return scriptLoadCache[src];
}

async function canUseHostingFirebaseRuntime() {
    if (firebaseHostingRuntimePromise) return firebaseHostingRuntimePromise;
    firebaseHostingRuntimePromise = (async () => {
        try {
            const res = await fetch('/__/firebase/init.js', { credentials: 'same-origin', cache: 'no-store' });
            if (!res.ok) return false;
            const contentType = String(res.headers.get('content-type') || '').toLowerCase();
            return contentType.includes('javascript');
        } catch (e) {
            return false;
        }
    })();
    return firebaseHostingRuntimePromise;
}

async function getFirebaseClient() {
    if (firebaseInitPromise) return firebaseInitPromise;
    firebaseInitPromise = (async () => {
        if (window.firebase && window.firebase.firestore) return window.firebase;
        try {
            const runtimeAvailable = await canUseHostingFirebaseRuntime();
            if (!runtimeAvailable) return null;
            await loadScriptOnce(`/__/firebase/${FIREBASE_SCRIPT_VERSION}/firebase-app-compat.js`);
            await loadScriptOnce(`/__/firebase/${FIREBASE_SCRIPT_VERSION}/firebase-firestore-compat.js`);
            await loadScriptOnce('/__/firebase/init.js');
            if (window.firebase && window.firebase.firestore) return window.firebase;
        } catch (e) {}
        return null;
    })();
    return firebaseInitPromise;
}

function setPublicSnapshot(snapshot, source) {
    PUBLIC_SNAPSHOT = normalizePublicSnapshot(snapshot);
    if (PUBLIC_SNAPSHOT.slug) {
        PROJECT_SLUG = PUBLIC_SNAPSHOT.slug;
        updateApiBase();
    }
    if (source) {
        PROJECT_SOURCE = source;
        maybeRewritePathToProjectSlug(PROJECT_SOURCE);
    }
}

function subscribeToFirestoreProject(docRef) {
    if (firestoreUnsubscribe) {
        try { firestoreUnsubscribe(); } catch (e) {}
    }

    firestoreUnsubscribe = docRef.onSnapshot((docSnap) => {
        if (!docSnap.exists) return;
        setPublicSnapshot(docSnap.data(), PROJECT_SOURCE);
        renderFromSnapshot().catch(() => {});
    }, () => {
        DATA_SOURCE = 'api';
    });
}

async function loadPublicSnapshotFromFirestore() {
    const firebaseClient = await getFirebaseClient();
    if (!firebaseClient || !firebaseClient.firestore) return null;

    const db = firebaseClient.firestore();
    let docRef = null;
    let source = PROJECT_SLUG ? 'path' : 'default';

    if (PROJECT_SLUG) {
        const slugQuery = await db.collection(PUBLIC_PROJECT_COLLECTION).where('slug', '==', PROJECT_SLUG).limit(1).get();
        if (!slugQuery.empty) docRef = slugQuery.docs[0].ref;
    }

    if (!docRef) {
        const host = normalizeDomainHost(window.location.hostname);
        if (host && !isLocalHost(host)) {
            const directDomainQuery = await db.collection(PUBLIC_PROJECT_COLLECTION).where('customDomain', '==', host).limit(1).get();
            if (!directDomainQuery.empty) {
                source = 'host';
                docRef = directDomainQuery.docs[0].ref;
            } else {
                const redirectDomainQuery = await db.collection(PUBLIC_PROJECT_COLLECTION).where('redirectDomains', 'array-contains', host).limit(1).get();
                if (!redirectDomainQuery.empty) {
                    source = 'host';
                    docRef = redirectDomainQuery.docs[0].ref;
                }
            }
        }
    }

    if (!docRef) {
        const firstProject = await db.collection(PUBLIC_PROJECT_COLLECTION).limit(1).get();
        if (firstProject.empty) return null;
        source = 'default';
        docRef = firstProject.docs[0].ref;
    }

    const docSnap = await docRef.get();
    if (!docSnap.exists) return null;

    setPublicSnapshot(docSnap.data(), source);
    subscribeToFirestoreProject(docRef);
    DATA_SOURCE = 'firestore';
    return PUBLIC_SNAPSHOT;
}

async function loadPublicSnapshotFromApi() {
    await resolveProjectViaApi();
    if (!PROJECT_SLUG) return null;
    updateApiBase();

    const response = await fetch(API_BASE + '/public-snapshot', { credentials: 'same-origin' });
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) return null;

    const payload = await response.json();
    if (!payload || payload.error) return null;

    DATA_SOURCE = 'api';
    setPublicSnapshot(payload, PROJECT_SOURCE || 'default');
    return PUBLIC_SNAPSHOT;
}

async function refreshPublicSnapshot() {
    const firestoreSnapshot = await loadPublicSnapshotFromFirestore();
    if (firestoreSnapshot) return firestoreSnapshot;
    return loadPublicSnapshotFromApi();
}

const STATUS_LABELS = {
    operational: 'Operational',
    degraded_performance: 'Degraded Performance',
    partial_outage: 'Partial Outage',
    major_outage: 'Major Outage',
    under_maintenance: 'Under Maintenance'
};
const INCIDENT_LABELS = {
    investigating: 'Investigating',
    identified: 'Identified',
    monitoring: 'Monitoring',
    resolved: 'Resolved',
    scheduled: 'Scheduled',
    in_progress: 'In Progress',
    verifying: 'Verifying',
    completed: 'Completed',
    postmortem: 'Postmortem'
};

function timeAgo(dateStr) {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff/60) + ' minutes ago';
    if (diff < 86400) return Math.floor(diff/3600) + ' hours ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDate(dateStr) {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}

function formatDay(dateStr) {
    return new Date(dateStr).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// ── Load status ──────────────────────────────────────────────────────────
async function loadStatus() {
    const status = await fetchJSON('/status');
    const banner = document.getElementById('statusBanner');
    const bar = document.getElementById('statusBar');
    const title = document.getElementById('statusTitle');

    banner.className = 'status-banner';
    bar.className = 'status-bar ' + status.status;
    document.getElementById('statusTime').textContent = formatDate(status.updatedAt);

    const titles = {
        operational: 'All Systems Operational',
        degraded_performance: 'Degraded System Performance',
        partial_outage: 'Partial System Outage',
        major_outage: 'Major System Outage',
        under_maintenance: 'System Under Maintenance'
    };
    title.textContent = titles[status.status] || 'All Systems Operational';
}

// ── Load settings ────────────────────────────────────────────────────────
let SETTINGS = {};
let loadedGaTrackingId = '';

function applyGoogleAnalytics(trackingId) {
    const id = (trackingId || '').trim();
    if (!id || id === loadedGaTrackingId) return;
    loadedGaTrackingId = id;
    if (!window.dataLayer) window.dataLayer = [];
    window.gtag = window.gtag || function(){ dataLayer.push(arguments); };
    const existing = document.getElementById('gaScript');
    if (!existing) {
        const s = document.createElement('script');
        s.id = 'gaScript';
        s.async = true;
        s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
        document.head.appendChild(s);
    }
    window.gtag('js', new Date());
    window.gtag('config', id);
}

async function loadSettings() {
    try {
        const s = await fetchJSON('/settings');
        SETTINGS = s || {};
        const displayTitle = s.pageTitle || s.pageName;
        if (displayTitle) {
            document.getElementById('pageTitle').textContent = displayTitle;
            document.title = displayTitle;
        }
        const robots = document.getElementById('metaRobots');
        if (robots) robots.setAttribute('content', s.hideFromSearchEngines ? 'noindex,nofollow' : 'index,follow');
        if (s.googleAnalyticsTrackingId) applyGoogleAnalytics(s.googleAnalyticsTrackingId);
        const aboutSection = document.getElementById('aboutSection');
        const aboutBody = document.getElementById('aboutBody');
        if (s.aboutText) {
            aboutBody.innerHTML = esc(s.aboutText).replace(/\n/g, '<br>');
            aboutSection.style.display = 'block';
        } else {
            aboutSection.style.display = 'none';
        }
        const uptimeSection = document.getElementById('uptimeSection');
        if (uptimeSection) {
            const showUptime = s.showUptime !== false;
            uptimeSection.style.display = (showUptime && s.componentsView !== 'bars') ? 'block' : 'none';
        }
    } catch(e) {}
}

// ── Load components ──────────────────────────────────────────────────────
async function loadComponents() {
    const data = await fetchJSON('/components');
    const container = document.getElementById('componentsContainer');
    const viewMode = (SETTINGS && SETTINGS.componentsView) ? SETTINGS.componentsView : 'list';
    if (viewMode === 'hidden') { container.innerHTML = ''; return; }
    let html = '';
    let list = data.components;
    if (!list && (data.groups || data.ungrouped)) {
        list = [];
        for (const g of data.groups || []) list.push(...(g.components || []));
        if (data.ungrouped) list.push(...data.ungrouped);
    }
    const roots = buildTree(list || []);
    if (!roots.length) { container.innerHTML = '<div class="no-incidents">No components available.</div>'; return; }
    html += `<div class="component-group"><div class="group-body">${roots.map(n => treeRow(n, 0)).join('')}</div></div>`;
    container.innerHTML = html;
}

// function renderComponentBars(data) {
//     const rows = [];
//     const groups = data.groups || [];
//     for (const group of groups) {
//         const comps = (group.components || []).filter(c => (c.view || 'list') === 'bars');
//         if (comps.length === 0) continue;
//         rows.push(componentBarRow(group.name, comps));
//     }
//     if (data.ungrouped && data.ungrouped.length) {
//         const ungrouped = data.ungrouped.filter(c => (c.view || 'list') === 'bars');
//         if (ungrouped.length) rows.push(componentBarRow('Ungrouped', ungrouped));
//     }
//     if (!rows.length) return '<div class="no-incidents">No components available.</div>';
//     return `<div class="component-bars">${rows.join('')}</div>`;
// }

function componentBarRow(label, components) {
    const counts = { operational: 0, degraded_performance: 0, partial_outage: 0, major_outage: 0, under_maintenance: 0 };
    for (const c of components) counts[c.status] = (counts[c.status] || 0) + 1;
    const total = components.length || 1;
    const seg = (key) => counts[key] ? `<span class="component-bar-seg ${key}" style="width:${(counts[key]/total)*100}%"></span>` : '';
    const meta = `${counts.operational}/${total} operational`;
    return `<div class="component-bar-row">
        <div class="component-bar-name">${esc(label)}</div>
        <div class="component-bar-track">${seg('operational')}${seg('degraded_performance')}${seg('partial_outage')}${seg('major_outage')}${seg('under_maintenance')}</div>
        <div class="component-bar-meta">${meta}</div>
    </div>`;
}

function componentRow(c) {
    return `<div class="component-row">
        <span class="component-name">${esc(c.name)}</span>
        <span class="component-status-label">
            <span class="status-text ${c.status}">${STATUS_LABELS[c.status] || c.status}</span>
            <span class="status-dot ${c.status}"></span>
        </span>
    </div>`;
}

// function toggleGroup(el) {
//     const body = el.nextElementSibling;
//     const chevron = el.querySelector('.group-chevron');
//     body.classList.toggle('collapsed');
//     chevron.classList.toggle('collapsed');
// }

function buildTree(list) {
    const map = new Map();
    for (const c of list) map.set(c.id, { ...c, children: [] });
    const roots = [];
    for (const c of map.values()) {
        if (c.parentId && map.has(c.parentId)) map.get(c.parentId).children.push(c);
        else roots.push(c);
    }
    const sortTree = (nodes) => {
        nodes.sort((a, b) => (a.order || 0) - (b.order || 0));
        for (const n of nodes) {
            if (n.children && n.children.length) sortTree(n.children);
        }
    };
    sortTree(roots);
    return roots;
}

let expandedNodes = new Set();
function treeRow(node, depth) {
    const indent = depth * 18;
    const hasChildren = node.children && node.children.length;
    const expanded = expandedNodes.has(node.id);
    const toggle = hasChildren ? `<span class="tree-toggle" onclick="toggleNode(${node.id});event.stopPropagation()">${expanded ? '&#9660;' : '&#9654;'}</span>` : '<span class="tree-toggle"></span>';
    return `<div class="component-row">
        <span class="component-name" style="padding-left:${indent}px">
            ${toggle}${esc(node.name)}
        </span>
        <span class="component-status-label">
            <span class="status-text ${node.status}">${STATUS_LABELS[node.status] || node.status}</span>
            <span class="status-dot ${node.status}"></span>
        </span>
    </div>
    ${hasChildren ? `<div class="${expanded ? '' : 'tree-children-hidden'}">${node.children.map(c => treeRow(c, depth + 1)).join('')}</div>` : ''}`;
}

function toggleNode(id) {
    if (expandedNodes.has(id)) expandedNodes.delete(id);
    else expandedNodes.add(id);
    loadComponents();
}

// ── Load uptime ──────────────────────────────────────────────────────────
async function loadUptime() {
    const [uptimeData, compData] = await Promise.all([
        fetchJSON('/uptime'),
        fetchJSON('/components')
    ]);

    const allComponents = [];
    if (Array.isArray(compData.components)) {
        allComponents.push(...compData.components);
    } else {
        for (const g of (compData.groups || [])) allComponents.push(...(g.components || []));
        if (compData.ungrouped) allComponents.push(...compData.ungrouped);
    }

    const container = document.getElementById('uptimeContainer');
    let html = '';

    for (const comp of allComponents) {
        const days = uptimeData[comp.id] || {};
        const sortedDates = [];
        const now = Date.now();
        for (let i = 89; i >= 0; i--) {
            sortedDates.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
        }
        const totalDays = sortedDates.length;
        const opDays = sortedDates.filter(d => (days[d] || 'operational') === 'operational').length;
        const pct = ((opDays / totalDays) * 100).toFixed(2);

        let bars = '';
        for (const d of sortedDates) {
            const s = days[d] || 'no-data';
            const label = s === 'no-data' ? 'No data' : STATUS_LABELS[s] || s;
            bars += `<div class="uptime-bar ${s}"><div class="tooltip">${d}<br>${label}</div></div>`;
        }

        html += `<div class="uptime-component">
            <div class="uptime-header">
                <span class="uptime-name">${esc(comp.name)}</span>
                <span class="uptime-pct">${pct}% uptime</span>
            </div>
            <div class="uptime-bars">${bars}</div>
            <div class="uptime-legend"><span>90 days ago</span><span>Today</span></div>
        </div>`;
    }

    container.innerHTML = html;
}

// ── Load incidents ───────────────────────────────────────────────────────
async function loadActiveIncidents() {
    const incidents = await fetchJSON('/incidents?status=active');
    const container = document.getElementById('activeIncidentsContainer');

    if (incidents.length === 0) {
        container.innerHTML = '';
        return;
    }

    let html = '<div class="incidents-section"><div class="section-header"><div class="section-title">Active Incidents</div></div>';
    for (const inc of incidents) {
        html += incidentCard(inc);
    }
    html += '</div>';
    container.innerHTML = html;
}

function incidentCard(inc) {
    let updates = '';
    const sorted = [...(inc.updates || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    for (const u of sorted) {
        updates += `<div class="incident-update">
            <div class="update-status ${u.status}">${INCIDENT_LABELS[u.status] || u.status}</div>
            <div class="update-body">
                <div class="update-message">${esc(u.message)}</div>
                <div class="update-time">${formatDate(u.createdAt)}</div>
            </div>
        </div>`;
    }
    return `<div class="incident-card">
        <div class="incident-header">
            <div class="incident-title">${esc(inc.title)}<span class="incident-impact ${inc.impact || 'minor'}">${inc.impact || 'minor'}</span></div>
            <div class="incident-meta">Started ${formatDate(inc.createdAt)}</div>
        </div>
        <div class="incident-updates">${updates}</div>
    </div>`;
}

// ── Load scheduled maintenances ──────────────────────────────────────────
async function loadMaintenances() {
    const list = await fetchJSON('/scheduled-maintenances');
    const container = document.getElementById('maintenanceContainer');

    if (list.length === 0) { container.innerHTML = ''; return; }

    let html = '<div class="incidents-section" style="margin-top:24px"><div class="section-header"><div class="section-title">Scheduled Maintenance</div></div>';
    for (const m of list) {
        let updates = '';
        const sorted = [...(m.updates || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        for (const u of sorted) {
            updates += `<div class="incident-update">
                <div class="update-status ${u.status}">${INCIDENT_LABELS[u.status] || u.status}</div>
                <div class="update-body">
                    <div class="update-message">${esc(u.message)}</div>
                    <div class="update-time">${formatDate(u.createdAt)}</div>
                </div>
            </div>`;
        }
        html += `<div class="maintenance-card">
            <div class="incident-header">
                <div class="incident-title"><span class="maintenance-badge">MAINTENANCE</span>${esc(m.title)}</div>
                <div class="incident-meta">Scheduled ${formatDate(m.scheduledStart)} - ${formatDate(m.scheduledEnd)}</div>
            </div>
            <div class="incident-updates">${updates}</div>
        </div>`;
    }
    html += '</div>';
    container.innerHTML = html;
}

// ── Incident history ─────────────────────────────────────────────────────
let cachedIncidents = [];
let currentHistoryDays = 7;

async function loadAllIncidents() {
    cachedIncidents = await fetchJSON('/incidents');
}

function showHistory(days, tabEl) {
    currentHistoryDays = days;
    document.querySelectorAll('.history-tab').forEach(t => t.classList.remove('active'));
    const target = tabEl || (typeof event !== 'undefined' ? event.target : null);
    if (target && target.classList) target.classList.add('active');
    renderHistory(days);
}

function renderHistory(days) {
    const container = document.getElementById('historyContainer');
    let html = '';
    const now = new Date();

    for (let i = 0; i < days; i++) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().slice(0, 10);
        const dayLabel = formatDay(dateStr + 'T12:00:00');

        const dayIncidents = cachedIncidents.filter(inc => {
            const incDate = new Date(inc.createdAt).toISOString().slice(0, 10);
            return incDate === dateStr;
        });

        html += `<div class="history-day"><div class="history-date">${dayLabel}</div>`;
        if (dayIncidents.length === 0) {
            html += '<div class="history-no-incidents">No incidents reported.</div>';
        } else {
            for (const inc of dayIncidents) {
                const lastUpdate = inc.updates && inc.updates.length ? inc.updates[inc.updates.length - 1] : null;
                html += `<div class="history-incident">
                    <div class="history-incident-title">
                        <span class="status-dot ${inc.status}" style="display:inline-block;width:8px;height:8px;margin-right:6px;vertical-align:middle"></span>
                        ${esc(inc.title)} - <em>${INCIDENT_LABELS[inc.status] || inc.status}</em>
                    </div>
                    ${lastUpdate ? '<div class="history-incident-time">' + esc(lastUpdate.message) + '</div>' : ''}
                </div>`;
            }
        }
        html += '</div>';
    }
    container.innerHTML = html;
}

// ── Subscribe ────────────────────────────────────────────────────────────
function openSubscribeModal() { document.getElementById('subscribeModal').classList.add('show'); }
function closeSubscribeModal() { document.getElementById('subscribeModal').classList.remove('show'); document.getElementById('subscribeMsg').textContent = ''; }

async function subscribe() {
    const email = document.getElementById('subscribeEmail').value.trim();
    const msg = document.getElementById('subscribeMsg');
    if (!email || !email.includes('@')) { msg.style.color = '#dc3545'; msg.textContent = 'Please enter a valid email.'; return; }
    try {
        const r = await fetch(API_BASE + '/subscribers', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await r.json();
        if (r.ok) { msg.style.color = '#3bd671'; msg.textContent = 'Subscribed successfully!'; document.getElementById('subscribeEmail').value = ''; }
        else { msg.style.color = '#dc3545'; msg.textContent = data.error || 'Failed to subscribe'; }
    } catch(e) { msg.style.color = '#dc3545'; msg.textContent = 'Network error'; }
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

async function renderFromSnapshot() {
    await loadSettings();
    await Promise.all([
        loadStatus(),
        loadComponents(),
        loadActiveIncidents(),
        loadMaintenances(),
        // loadUptime(),
        loadAllIncidents()
    ]);
    renderHistory(currentHistoryDays);
}

// ── Init ─────────────────────────────────────────────────────────────────
async function init() {
    const snapshot = await refreshPublicSnapshot();
    if (!snapshot) await resolveProjectViaApi();

    await renderFromSnapshot();

    // Auto-refresh only when Firestore realtime is not available.
    if (DATA_SOURCE !== 'firestore') {
        setInterval(async () => {
            await refreshPublicSnapshot();
            await renderFromSnapshot();
        }, 60000);
    }
}

init();
