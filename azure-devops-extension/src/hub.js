(function () {
  const DOM = {
    projectContext: document.getElementById('projectContext'),
    projectSelect: document.getElementById('projectSelect'),
    refreshBtn: document.getElementById('refreshBtn'),
    openStatusBtn: document.getElementById('openStatusBtn'),
    openAdminBtn: document.getElementById('openAdminBtn'),
    overallStatus: document.getElementById('overallStatus'),
    activeIncidents: document.getElementById('activeIncidents'),
    scheduledMaintenances: document.getElementById('scheduledMaintenances'),
    componentsCount: document.getElementById('componentsCount'),
    incidentsList: document.getElementById('incidentsList'),
    runtimeInfo: document.getElementById('runtimeInfo'),
    errorMessage: document.getElementById('errorMessage')
  };

  const STATUS_LABELS = {
    operational: { text: 'Operational', css: 'status-ok' },
    degraded_performance: { text: 'Degraded Performance', css: 'status-warning' },
    partial_outage: { text: 'Partial Outage', css: 'status-warning' },
    major_outage: { text: 'Major Outage', css: 'status-error' },
    under_maintenance: { text: 'Under Maintenance', css: 'status-warning' }
  };

  const state = {
    config: null,
    context: null,
    projects: [],
    selectedSlug: ''
  };

  function setError(message) {
    if (!message) {
      DOM.errorMessage.hidden = true;
      DOM.errorMessage.textContent = '';
      return;
    }
    DOM.errorMessage.hidden = false;
    DOM.errorMessage.textContent = message;
  }

  function normalizeBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw.replace(/\/$/, '');
  }

  function buildUrl(baseUrl, path) {
    return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  async function fetchJson(url) {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Request failed (${res.status}): ${body || res.statusText}`);
    }
    return res.json();
  }

  async function loadConfig() {
    const config = await fetchJson('../extension-config.json');
    return {
      apiBaseUrl: normalizeBaseUrl(config.apiBaseUrl),
      defaultProjectSlug: String(config.defaultProjectSlug || '').trim(),
      projectSlugMap: (config.projectSlugMap && typeof config.projectSlugMap === 'object') ? config.projectSlugMap : {},
      publicPageUrlTemplate: String(config.publicPageUrlTemplate || '').trim(),
      adminPageUrl: String(config.adminPageUrl || '').trim()
    };
  }

  async function initSdk() {
    if (!window.SDK) return null;
    window.SDK.init({ loaded: false, applyTheme: true });
    await window.SDK.ready();
    return window.SDK.getWebContext ? window.SDK.getWebContext() : null;
  }

  function getProjectNameFromContext(context) {
    return context && context.project && context.project.name ? String(context.project.name).trim() : '';
  }

  function resolveInitialSlug(config, contextProjectName, projects) {
    const projectSlugSet = new Set(projects.map((project) => String(project.slug || '')));
    if (contextProjectName && config.projectSlugMap[contextProjectName]) {
      const mapped = String(config.projectSlugMap[contextProjectName] || '').trim();
      if (projectSlugSet.has(mapped)) return mapped;
    }
    if (config.defaultProjectSlug && projectSlugSet.has(config.defaultProjectSlug)) return config.defaultProjectSlug;
    if (projects.length > 0) return projects[0].slug;
    return '';
  }

  function renderProjectOptions(projects, selectedSlug) {
    DOM.projectSelect.innerHTML = '';
    for (const project of projects) {
      const option = document.createElement('option');
      option.value = String(project.slug || '');
      option.textContent = `${String(project.name || '')} (${String(project.slug || '')})`;
      option.selected = project.slug === selectedSlug;
      DOM.projectSelect.appendChild(option);
    }
    DOM.projectSelect.disabled = projects.length === 0;
  }

  function renderIncidentList(snapshot) {
    const incidents = Array.isArray(snapshot.incidents) ? snapshot.incidents : [];
    const active = incidents.filter((item) => item.status !== 'resolved' && item.status !== 'postmortem').slice(0, 5);

    if (active.length === 0) {
      DOM.incidentsList.innerHTML = '<p class="muted">No active incidents.</p>';
      return;
    }

    DOM.incidentsList.innerHTML = active.map((incident) => {
      const createdAt = incident.createdAt ? new Date(incident.createdAt).toLocaleString() : '-';
      return `
        <article class="item">
          <h3>${escapeHtml(incident.title || 'Incident')}</h3>
          <p>${escapeHtml(incident.status || 'unknown')} - ${escapeHtml(createdAt)}</p>
        </article>
      `;
    }).join('');
  }

  function escapeHtml(value) {
    const span = document.createElement('span');
    span.textContent = String(value || '');
    return span.innerHTML;
  }

  function applyStatus(statusCode) {
    const normalized = String(statusCode || 'operational').trim();
    const meta = STATUS_LABELS[normalized] || { text: normalized || 'Unknown', css: 'status-warning' };
    DOM.overallStatus.className = `value ${meta.css}`;
    DOM.overallStatus.textContent = meta.text;
  }

  function updateActionLinks(slug) {
    const publicTemplate = state.config.publicPageUrlTemplate;
    const adminUrl = state.config.adminPageUrl;

    DOM.openStatusBtn.disabled = !publicTemplate;
    DOM.openAdminBtn.disabled = !adminUrl;

    DOM.openStatusBtn.onclick = null;
    DOM.openAdminBtn.onclick = null;

    if (publicTemplate) {
      const url = publicTemplate.replace('{slug}', encodeURIComponent(slug));
      DOM.openStatusBtn.onclick = () => window.open(url, '_blank', 'noopener,noreferrer');
    }
    if (adminUrl) {
      DOM.openAdminBtn.onclick = () => window.open(adminUrl, '_blank', 'noopener,noreferrer');
    }
  }

  async function loadSnapshotForSlug(slug) {
    if (!slug) return;
    const endpoint = buildUrl(state.config.apiBaseUrl, `/api/v1/projects/${encodeURIComponent(slug)}/public-snapshot`);
    DOM.refreshBtn.disabled = true;
    setError('');
    DOM.runtimeInfo.textContent = `Loading snapshot for ${slug}...`;

    try {
      const snapshot = await fetchJson(endpoint);
      const incidents = Array.isArray(snapshot.incidents) ? snapshot.incidents : [];
      const activeIncidents = incidents.filter((item) => item.status !== 'resolved' && item.status !== 'postmortem').length;
      const maintenances = Array.isArray(snapshot.scheduledMaintenances) ? snapshot.scheduledMaintenances : [];
      const components = Array.isArray(snapshot.components) ? snapshot.components : [];

      applyStatus(snapshot.overallStatus);
      DOM.activeIncidents.textContent = String(activeIncidents);
      DOM.scheduledMaintenances.textContent = String(maintenances.length);
      DOM.componentsCount.textContent = String(components.length);
      renderIncidentList(snapshot);
      DOM.runtimeInfo.textContent = `Last refreshed: ${new Date().toLocaleString()}`;
      updateActionLinks(slug);
    } catch (err) {
      setError(err.message || 'Failed to load snapshot.');
      DOM.runtimeInfo.textContent = 'Unable to refresh snapshot.';
    } finally {
      DOM.refreshBtn.disabled = false;
    }
  }

  async function initialize() {
    try {
      state.context = await initSdk();
      state.config = await loadConfig();

      if (!state.config.apiBaseUrl) {
        throw new Error('extension-config.json apiBaseUrl is empty.');
      }

      const projectsUrl = buildUrl(state.config.apiBaseUrl, '/api/v1/projects');
      const projects = await fetchJson(projectsUrl);
      state.projects = Array.isArray(projects) ? projects : [];

      const contextProjectName = getProjectNameFromContext(state.context);
      state.selectedSlug = resolveInitialSlug(state.config, contextProjectName, state.projects);

      renderProjectOptions(state.projects, state.selectedSlug);
      DOM.projectContext.textContent = contextProjectName
        ? `Azure DevOps project: ${contextProjectName}`
        : 'Azure DevOps project context not available';

      DOM.projectSelect.addEventListener('change', async (event) => {
        state.selectedSlug = event.target.value;
        await loadSnapshotForSlug(state.selectedSlug);
      });

      DOM.refreshBtn.addEventListener('click', async () => {
        await loadSnapshotForSlug(state.selectedSlug);
      });

      if (!state.selectedSlug) {
        DOM.runtimeInfo.textContent = 'No status project could be resolved from configuration.';
      } else {
        await loadSnapshotForSlug(state.selectedSlug);
      }

      if (window.SDK && window.SDK.notifyLoadSucceeded) window.SDK.notifyLoadSucceeded();
    } catch (err) {
      setError(err.message || 'Failed to initialize extension.');
      DOM.runtimeInfo.textContent = 'Initialization failed.';
      if (window.SDK && window.SDK.notifyLoadFailed) window.SDK.notifyLoadFailed(err.message || 'Initialization failed');
    }
  }

  initialize();
})();
