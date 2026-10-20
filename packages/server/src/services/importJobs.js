// Recipe import: adapter to @flow-recipe/importer (ESM workspace package, loaded with a dynamic import like
// planning.js loads the scheduler) and an in-memory job runner for POST /api/import.
//
// Secrets: an API key sent by a client lives only in the closure of the running job. It is never stored on the job
// object, never logged, scrubbed from error messages and dropped as soon as the job finishes.

const path = require('path');
const { pathToFileURL } = require('url');
const { v4: uuidv4 } = require('uuid');

const PROVIDERS = ['anthropic', 'openai', 'openai-compatible', 'ollama'];
const JOB_TTL_MS = parseInt(process.env.FLOW_IMPORT_JOB_TTL_MS || String(60 * 60 * 1000), 10);
const JOB_TIMEOUT_MS = parseInt(process.env.FLOW_IMPORT_JOB_TIMEOUT_MS || String(10 * 60 * 1000), 10);
const MAX_RUNNING = parseInt(process.env.FLOW_IMPORT_MAX_JOBS || '20', 10);
const MAX_RUNNING_PER_IP = parseInt(process.env.FLOW_IMPORT_MAX_JOBS_PER_IP || '3', 10);
const MAX_STORED_JOBS = 500;

// ---- module loading -----------------------------------------------------------------------------------------------

let importerPromise = null;
let schedulerPromise = null;

function importFirst(specifiers) {
  return specifiers.reduce(
    (chain, spec) => chain.catch(() => import(spec)),
    Promise.reject(new Error('start'))
  );
}

// Resolves to the importer module, or null when it is not available (the import endpoints then answer 503).
function loadImporter() {
  if (!importerPromise) {
    const fallback = pathToFileURL(path.join(__dirname, '..', '..', '..', 'importer', 'src', 'index.js')).href;
    importerPromise = importFirst(['@flow-recipe/importer', fallback])
      .then((mod) => {
        console.log('[import] @flow-recipe/importer loaded');
        return mod;
      })
      .catch((error) => {
        importerPromise = null; // retry on the next request (the package may still be installed later)
        console.warn('[import] cannot load @flow-recipe/importer:', error.message);
        return null;
      });
  }
  return importerPromise;
}

function loadScheduler() {
  if (!schedulerPromise) {
    schedulerPromise = importFirst(['@flow-recipe/scheduler/conversions', '@flow-recipe/scheduler']).catch(() => {
      schedulerPromise = null;
      return null;
    });
  }
  return schedulerPromise;
}

// metricizeRecipeXml / DENSITIES from the importer (re-export) or from @flow-recipe/scheduler/conversions.
async function conversions() {
  const importer = await loadImporter();
  if (importer && typeof importer.metricizeRecipeXml === 'function' && importer.DENSITIES) return importer;
  const scheduler = await loadScheduler();
  if (scheduler && typeof scheduler.metricizeRecipeXml === 'function') return scheduler;
  return importer && typeof importer.metricizeRecipeXml === 'function' ? importer : null;
}

// ---- LLM configuration --------------------------------------------------------------------------------------------

function mockAllowed() {
  return process.env.NODE_ENV === 'test' || process.env.FLOW_ALLOW_MOCK_LLM === '1';
}

function serverLlmConfig(importer) {
  if (!importer || typeof importer.llmConfigFromEnv !== 'function') return null;
  let config = null;
  try {
    config = importer.llmConfigFromEnv(process.env);
  } catch (error) {
    console.warn('[import] invalid LLM configuration in the environment:', scrub(error.message, []));
    return null;
  }
  if (!config) return null;
  if (config.provider === 'mock' && !mockAllowed()) return null;
  return config;
}

function describe(importer, config) {
  if (!config) return null;
  let described;
  if (importer && typeof importer.describeLlmConfig === 'function') {
    described = importer.describeLlmConfig(config);
  } else {
    described = { provider: config.provider, model: config.model || null, baseUrl: config.baseUrl || null };
  }
  const { apiKey, ...rest } = described || {};
  if (rest.baseUrl) rest.baseUrl = publicBaseUrl(rest.baseUrl);
  return { ...rest, hasKey: !!config.apiKey };
}

// A base URL safe to show to anyone: no credentials, query (Azure-style ?api-key=) or fragment.
function publicBaseUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  } catch (error) {
    return null;
  }
}

function trimSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function str(value, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

// Validates the `llm` object of a request. Returns { config } or { error }.
function clientLlmConfig(llm) {
  if (!llm || typeof llm !== 'object' || Array.isArray(llm)) return { error: 'llm must be an object' };
  const provider = llm.provider;
  if (provider === 'mock') {
    if (!mockAllowed()) return { error: "LLM provider 'mock' is not allowed" };
    if (typeof llm.mockResponse !== 'string') return { error: 'mock provider needs mockResponse (string)' };
    return { config: { provider: 'mock', model: 'mock', mockResponse: llm.mockResponse } };
  }
  if (!PROVIDERS.includes(provider)) return { error: `Unknown LLM provider '${provider}'` };
  const config = { provider };
  const model = str(llm.model, 200);
  const apiKey = str(llm.apiKey, 1000);
  const baseUrl = str(llm.baseUrl, 2000);
  if (model) config.model = model;
  if (apiKey) config.apiKey = apiKey;
  if (baseUrl) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch (error) {
      return { error: 'llm.baseUrl is not a valid URL' };
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return { error: 'llm.baseUrl must be http(s)' };
    if (parsed.username || parsed.password) return { error: 'llm.baseUrl must not contain credentials' };
    if (parsed.search || parsed.hash || baseUrl.includes('?') || baseUrl.includes('#')) {
      return { error: 'llm.baseUrl must not contain a query or fragment' };
    }
    config.baseUrl = baseUrl;
  }
  if ((provider === 'anthropic' || provider === 'openai') && !apiKey) {
    return { error: `llm.apiKey is required for ${provider}` };
  }
  return { config };
}

function scrub(message, secrets) {
  let text = String(message || 'Import failed');
  for (const secret of secrets) {
    if (secret && secret.length >= 4) text = text.split(secret).join('***');
  }
  // Belt and braces: anything that looks like a provider key.
  return text.replace(/\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,})\b/g, '***').slice(0, 2000);
}

// ---- outbound requests for a client-supplied LLM configuration ---------------------------------------------------
//
// A client may point the server at any LLM base URL. The server must not become a proxy into its own network:
// private, loopback and link-local hosts are refused (checked again at connect time by the importer's pinned fetch)
// unless the operator allows them with FLOW_LLM_ALLOW_PRIVATE=1 or the URL is the server's own FLOW_LLM_BASE_URL
// (e.g. a local Ollama the operator configured). Response bodies from client-supplied endpoints never reach the job
// error, only the status code.

function llmPrivateAllowedFor(baseUrl) {
  if (process.env.FLOW_LLM_ALLOW_PRIVATE === '1') return true;
  const own = process.env.FLOW_LLM_BASE_URL;
  return !!(own && baseUrl && trimSlash(own) === trimSlash(baseUrl));
}

/**
 * Completes a config from clientLlmConfig for use by this server: checks the effective base URL and installs the
 * guarded fetch. Throws an error with status 400 when the base URL is not allowed.
 */
async function secureClientLlmConfig(importer, config) {
  if (!config || config.provider === 'mock') return config;
  if (!importer || typeof importer.createGuardedFetch !== 'function' || typeof importer.assertPublicUrl !== 'function') {
    throw httpError(503, 'Recipe importer is not available on this server');
  }
  const described = typeof importer.describeLlmConfig === 'function' ? importer.describeLlmConfig(config) : null;
  const effective = config.baseUrl || (described && described.baseUrl) || null;
  const allowPrivate = llmPrivateAllowedFor(effective);
  // The provider defaults (api.anthropic.com, api.openai.com) are public; a client-chosen URL and Ollama's
  // localhost default are checked up front. Every connection is checked again by the guarded fetch.
  if (effective && (config.baseUrl || config.provider === 'ollama')) {
    try {
      await importer.assertPublicUrl(effective, { allowPrivate });
    } catch (error) {
      const hint = error.code === 'blocked-address'
        ? ' (private and local LLM servers can only be used when the server operator configures them: FLOW_LLM_BASE_URL or FLOW_LLM_ALLOW_PRIVATE=1)'
        : '';
      throw httpError(400, `llm.baseUrl is not allowed: ${error.message}${hint}`);
    }
  }
  const trustedEndpoint = !config.baseUrl || (!!process.env.FLOW_LLM_BASE_URL && trimSlash(process.env.FLOW_LLM_BASE_URL) === trimSlash(config.baseUrl));
  return { ...config, fetch: importer.createGuardedFetch({ allowPrivate }), errorDetail: trustedEndpoint };
}

// ---- jobs -------------------------------------------------------------------------------------------------------

const jobs = new Map(); // jobId -> job (public fields only, no secrets)

// Jobs whose work has not settled yet (a cancelled job counts until its work has actually stopped).
function runningJobs() {
  return [...jobs.values()].filter((job) => job.active);
}

function view(job) {
  if (!job) return null;
  const out = {
    id: job.id,
    status: job.status,
    stage: job.stage,
    detail: job.detail,
    attempts: job.attempts,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
  if (job.result) out.result = job.result;
  if (job.error) out.error = job.error;
  return out;
}

function getJob(id) {
  return view(jobs.get(id));
}

function sweep(now = Date.now()) {
  for (const [id, job] of jobs) {
    const age = now - (job.finishedAt || job.createdAt);
    if (!job.active && age > JOB_TTL_MS) jobs.delete(id);
  }
  // Hard cap on remembered jobs: drop the oldest finished ones.
  if (jobs.size > MAX_STORED_JOBS) {
    const finished = [...jobs.values()].filter((j) => !j.active).sort((a, b) => a.createdAt - b.createdAt);
    for (const job of finished.slice(0, jobs.size - MAX_STORED_JOBS)) jobs.delete(job.id);
  }
}

const sweeper = setInterval(sweep, 60 * 1000);
if (sweeper.unref) sweeper.unref();

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sanitizeResult(result, existingIds, importer) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };
  if (out.llm && typeof out.llm === 'object') {
    const { apiKey, ...rest } = out.llm;
    out.llm = rest;
  }
  // Suggest an id that does not collide with a built-in or a saved recipe (the importer already got the taken ids;
  // this catches recipes saved while the job ran). The root id attribute always matches the suggested id.
  if (typeof out.id === 'string' && existingIds.has(out.id)) {
    if (importer && typeof importer.suggestRecipeId === 'function') {
      out.id = importer.suggestRecipeId(out.id, [...existingIds]);
    } else {
      let n = 2;
      while (existingIds.has(`${out.id}-${n}`)) n++;
      out.id = `${out.id}-${n}`;
    }
  }
  if (typeof out.id === 'string' && typeof out.xml === 'string' && out.xml && importer && typeof importer.setRootAttributes === 'function') {
    out.xml = importer.setRootAttributes(out.xml, { id: out.id });
    if (out.check && typeof out.check === 'object') out.check = { ...out.check, id: out.id };
  }
  return out;
}

/**
 * Starts an import job. `params` = validated request fields { url?, text?, ref?, precisionScale, servings, notes },
 * `llmConfig` = the provider configuration (may hold an API key; it is only kept in this closure).
 * `existingIds()` lists recipe ids already taken. Throws with `status` 429 when the concurrency caps are reached.
 */
function startJob({ params, llmConfig, ip = 'unknown', existingIds = () => [] }) {
  sweep();
  const running = runningJobs();
  if (running.length >= MAX_RUNNING) throw httpError(429, 'Too many imports running, try again shortly');
  if (running.filter((job) => job.ip === ip).length >= MAX_RUNNING_PER_IP) {
    throw httpError(429, 'Too many imports running from your address, wait for one to finish');
  }

  const job = {
    id: uuidv4(),
    ip,
    status: 'running',
    stage: 'queued',
    detail: null,
    attempts: 0,
    createdAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
    controller: new AbortController(),
  };
  Object.defineProperty(job, 'controller', { enumerable: false });
  Object.defineProperty(job, 'active', { value: true, writable: true, enumerable: false });
  jobs.set(job.id, job);

  let config = llmConfig; // the only reference to the key; cleared in finally
  const secrets = [config && config.apiKey].filter(Boolean);
  const timeout = setTimeout(() => job.controller.abort(new Error('Import timed out')), JOB_TIMEOUT_MS);
  if (timeout.unref) timeout.unref();

  const progress = (stage, detail) => {
    if (job.status !== 'running') return;
    job.stage = typeof stage === 'string' ? stage : job.stage;
    if (detail === undefined || detail === null) job.detail = null;
    else if (typeof detail === 'string' || typeof detail === 'number') job.detail = detail;
    else if (typeof detail === 'object') {
      try {
        job.detail = JSON.parse(scrub(JSON.stringify(detail), secrets));
      } catch (error) {
        job.detail = null;
      }
    }
    if (detail && typeof detail === 'object' && Number.isFinite(detail.attempt)) job.attempts = detail.attempt;
    else if (stage === 'generating' && job.attempts === 0) job.attempts = 1;
    else if (stage === 'repairing') job.attempts += 1;
  };

  (async () => {
    const importer = await loadImporter();
    if (!importer || typeof importer.importRecipe !== 'function') throw new Error('Importer not available');
    const signal = job.controller.signal;
    let source = null;
    if (params.url) {
      progress('fetching', params.url);
      if (typeof importer.fetchRecipeSource !== 'function') throw new Error('Importer cannot fetch URLs');
      // The importer's default fetch is the pinned SSRF-guarded one (FLOW_IMPORT_ALLOW_PRIVATE=1 lifts it).
      source = await importer.fetchRecipeSource(params.url, { signal });
    } else if (params.text && typeof importer.textSource === 'function') {
      // params.ref (the page the user tried) is only recorded as the recipe's ref; it is never fetched
      source = importer.textSource(params.text, { url: params.ref || null });
    }
    if (signal.aborted) throw signal.reason || new Error('Cancelled');
    const result = await importer.importRecipe({
      ...(source ? { source } : { text: params.text, ref: params.ref || null }),
      llm: config,
      precisionScale: params.precisionScale,
      servings: params.servings,
      notes: params.notes,
      onProgress: progress,
      signal,
      existingIds: existingIds(),
    });
    if (signal.aborted) throw signal.reason || new Error('Cancelled');
    return sanitizeResult(result, new Set(existingIds()), importer);
  })()
    .then((result) => {
      if (job.status !== 'running') return;
      job.result = result;
      if (result && Number.isFinite(result.attempts)) job.attempts = result.attempts;
      job.status = 'done';
      job.stage = 'done';
      job.detail = null;
    })
    .catch((error) => {
      if (job.status !== 'running') return;
      const reason = job.controller.signal.aborted ? job.controller.signal.reason : null;
      const message = reason && reason.message ? reason.message : error && error.message;
      job.status = 'error';
      job.error = scrub(message, secrets);
      console.warn(`[import] job ${job.id} failed at ${job.stage}: ${job.error}`);
    })
    .finally(() => {
      clearTimeout(timeout);
      config = null;
      secrets.length = 0;
      job.active = false;
      if (!job.finishedAt) job.finishedAt = Date.now();
    });

  console.log(`[import] job ${job.id} started (${llmConfig.provider}${params.url ? ', url' : ', text'})`);
  return view(job);
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'running') {
    job.controller.abort(new Error('Cancelled'));
    job.status = 'error';
    job.error = 'Cancelled';
    job.finishedAt = Date.now();
  }
  return view(job);
}

module.exports = {
  PROVIDERS,
  loadImporter,
  conversions,
  mockAllowed,
  serverLlmConfig,
  clientLlmConfig,
  describe,
  secureClientLlmConfig,
  startJob,
  getJob,
  cancelJob,
  sweep,
};
