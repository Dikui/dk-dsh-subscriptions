import { fail, SubscriptionError } from './core.js';

function waitFor(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([promise, cancelled]).finally(() => signal.removeEventListener('abort', abort));
}

function validatedModels(value) {
  if (!Array.isArray(value) || value.length > 1000) fail('MODEL_CATALOG_INVALID');
  const selected = new Map();
  for (const model of value) {
    if (typeof model?.id !== 'string' || !model.id.trim() || model.id.length > 200 || /[\x00-\x1f\x7f]/.test(model.id)
      || typeof model.name !== 'string' || !model.name.trim() || model.name.length > 200) fail('MODEL_CATALOG_INVALID');
    if (!selected.has(model.id)) selected.set(model.id, model);
  }
  return [...selected.values()];
}

// Sources provide an opaque account identity and normalized native model descriptors.
// Identity is never public; one instance owns one vendor's cache and in-flight query.
function createAccountMetadata({ readIdentity, resolveIdentity = readIdentity, loadValue, validate, empty, errorPrefix, scope = 'account', onChange = () => {} }) {
  const code = suffix => `${errorPrefix}_${suffix}`;
  let models = empty, owner, generation = 0, identityGeneration = 0, flight, checkedAt = 0;
  let identityController = new AbortController();
  let state = { source: 'account', scope, state: 'unloaded', error: null, updatedAt: null };
  function reset(preserveIdentityReaders = false) {
    generation++;
    if (!preserveIdentityReaders) {
      identityGeneration++;
      identityController.abort(new SubscriptionError(code('CHANGED')));
      identityController = new AbortController();
    }
    flight?.controller.abort(new SubscriptionError(code('CHANGED')));
    flight = undefined;
    owner = undefined;
    checkedAt = 0;
    const changed = models !== empty;
    models = empty;
    state = { source: 'account', scope, state: 'unloaded', error: null, updatedAt: null };
    if (changed) onChange();
  }
  function clear() { reset(); }
  async function ensure({ force = false, signal } = {}) {
    signal?.throwIfAborted();
    // Valid same-grant readers may coalesce across rotation; obsolete failed reads
    // must still be fenced by the catalog generation before they can clear anything.
    const readingGeneration = identityGeneration, readingCatalogGeneration = generation;
    const identitySignal = AbortSignal.any([identityController.signal, AbortSignal.timeout(10000)]);
    let initial;
    try { initial = await waitFor(waitFor(Promise.resolve().then(() => readIdentity(identitySignal)), identitySignal), signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (readingGeneration !== identityGeneration || readingCatalogGeneration !== generation) fail(code('CHANGED'));
      clear(); fail(error instanceof SubscriptionError ? error.code : code('FAILED'));
    }
    signal?.throwIfAborted();
    if (readingGeneration !== identityGeneration) fail(code('CHANGED'));
    if (typeof initial !== 'string' || !initial) {
      if (readingCatalogGeneration !== generation) fail(code('CHANGED'));
      clear(); fail('MISSING_CREDENTIAL');
    }
    // A grant can be persisted just before the official resolver returns it. Its
    // own readers must share that resolution rather than abort it as an account switch.
    // The resolver and the final identity check still fence unrelated replacements.
    if (flight?.resolving) return waitFor(flight.promise, signal);
    if (owner === undefined) owner = initial;
    else if (owner !== initial) {
      // Recheck a slow reader after another caller already moved to a new grant.
      // Old responses must not revert the owner; readers of the same rotated grant can coalesce.
      const latest = await waitFor(waitFor(readIdentity(identitySignal), identitySignal), signal);
      if (readingGeneration !== identityGeneration || latest !== initial) fail(code('CHANGED'));
      if (owner !== initial) { reset(true); owner = initial; }
    }
    if (flight) return waitFor(flight.promise, signal);
    if (!force && checkedAt && Date.now() - checkedAt < 60000) {
      if (state.error) fail(state.error);
      return;
    }
    const current = { generation, controller: new AbortController(), resolving: true };
    flight = current;
    // A caller leaving must not cancel another caller's shared metadata query.
    const requestSignal = AbortSignal.any([current.controller.signal, AbortSignal.timeout(10000)]);
    // Keep the last validated display for this same grant while it refreshes: list and
    // resolve stay instant, while every authorization path still awaits this flight.
    // A cold read has nothing to keep and shows its loading state instead.
    state = { source: 'account', scope, state: state.state === 'unloaded' ? 'loading' : state.state,
      error: state.state === 'error' ? state.error : null, updatedAt: state.updatedAt };
    current.promise = (async () => {
      const resolved = await waitFor(resolveIdentity(requestSignal), requestSignal);
      if (generation !== current.generation) fail(code('CHANGED'));
      if (typeof resolved !== 'string' || !resolved) fail('MISSING_CREDENTIAL');
      // Official refresh may rotate this grant. Adopt it within this flight without
      // invalidating the callers sharing it, then fence the final metadata by that grant.
      initial = resolved;
      owner = resolved;
      current.resolving = false;
      const next = validate(await waitFor(loadValue({ identity: initial, signal: requestSignal }), requestSignal));
      const latest = await waitFor(readIdentity(requestSignal), requestSignal);
      if (generation !== current.generation || latest !== initial) fail(code('CHANGED'));
      requestSignal.throwIfAborted();
      models = next;
      checkedAt = Date.now();
      state = { source: 'account', scope, state: 'ready', error: null, updatedAt: checkedAt };
      onChange();
    })().catch(error => {
      const errorCode = generation !== current.generation ? code('CHANGED')
        : error instanceof SubscriptionError ? error.code : code('FAILED');
      if (generation === current.generation) {
        models = empty;
        checkedAt = Date.now();
        state = { source: 'account', scope, state: 'error', error: errorCode, updatedAt: null };
        onChange();
      }
      throw new SubscriptionError(errorCode); // Never expose bodies, headers, credentials or upstream messages.
    }).finally(() => { if (flight === current) flight = undefined; });
    return waitFor(current.promise, signal);
  }
  function snapshot() { return { ...state, models }; }
  // Display read: answers from the last validated collection and, when it is stale,
  // starts one refresh whose settled result is announced through onChange. It never
  // waits for that refresh and never authorizes anything (ensure/prepareCall/stream do).
  async function observe({ signal } = {}) {
    signal?.throwIfAborted();
    const readingGeneration = identityGeneration, readingCatalogGeneration = generation;
    const identitySignal = AbortSignal.any([identityController.signal, AbortSignal.timeout(10000)]);
    let identity, failure;
    try { identity = await waitFor(waitFor(Promise.resolve().then(() => readIdentity(identitySignal)), identitySignal), signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (readingGeneration !== identityGeneration || readingCatalogGeneration !== generation) return snapshot();
      failure = error instanceof SubscriptionError ? error.code : code('FAILED');
    }
    signal?.throwIfAborted();
    if (readingGeneration !== identityGeneration || readingCatalogGeneration !== generation) return snapshot();
    if (failure) {
      // A credential that cannot be read must not keep a list attributed to it.
      if (models !== empty || owner !== undefined || state.state !== 'unloaded') reset();
      return { ...snapshot(), missing: true, failure };
    }
    if (typeof identity !== 'string' || !identity) {
      if (models !== empty || owner !== undefined || state.state !== 'unloaded') reset();
      return { ...snapshot(), missing: true };
    }
    // A rotated or replaced grant drops the old display at once; the read below only
    // fills it again from the new account's own catalog.
    if (owner !== undefined && owner !== identity) reset(true);
    if (!flight) {
      const stale = !checkedAt || Date.now() - checkedAt >= 60000;
      if (state.state === 'unloaded' || ((state.state === 'ready' || state.state === 'error') && stale)) {
        void ensure().catch(() => {});
      }
    }
    return snapshot();
  }
  return { ensure, observe, clear, getValue: () => models, status: () => ({ ...state }) };
}

export function createAccountModels({ loadModels, ...options }) {
  const metadata = createAccountMetadata({ ...options, loadValue: loadModels, validate: validatedModels,
    empty: [], errorPrefix: 'MODEL_CATALOG' });
  return { ensure: metadata.ensure, observe: metadata.observe, clear: metadata.clear, status: metadata.status,
    getModels: metadata.getValue };
}

export function createAccountQuota({ loadModels, ...options }) {
  const metadata = createAccountMetadata({ ...options, loadValue: loadModels, validate: value => value,
    empty: null, errorPrefix: 'QUOTA' });
  return { ensure: metadata.ensure, clear: metadata.clear, status() {
    const state = metadata.status(), value = metadata.getValue();
    return { ...state, state: state.state === 'ready' && value?.partial ? 'partial' : state.state,
      stale: state.updatedAt !== null && Date.now() - state.updatedAt >= 60000, windows: value?.windows ?? [] };
  } };
}
