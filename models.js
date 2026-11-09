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
export function createAccountModels({ readIdentity, resolveIdentity = readIdentity, loadModels, scope = 'account', onChange = () => {} }) {
  let models = [], owner, generation = 0, identityGeneration = 0, flight, checkedAt = 0;
  let identityController = new AbortController();
  let state = { source: 'account', scope, state: 'unloaded', error: null, updatedAt: null };
  function reset(preserveIdentityReaders = false) {
    generation++;
    if (!preserveIdentityReaders) {
      identityGeneration++;
      identityController.abort(new SubscriptionError('MODEL_CATALOG_CHANGED'));
      identityController = new AbortController();
    }
    flight?.controller.abort(new SubscriptionError('MODEL_CATALOG_CHANGED'));
    flight = undefined;
    owner = undefined;
    checkedAt = 0;
    const changed = models.length > 0;
    models = [];
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
      if (readingGeneration !== identityGeneration || readingCatalogGeneration !== generation) fail('MODEL_CATALOG_CHANGED');
      clear(); fail(error instanceof SubscriptionError ? error.code : 'MODEL_CATALOG_FAILED');
    }
    signal?.throwIfAborted();
    if (readingGeneration !== identityGeneration) fail('MODEL_CATALOG_CHANGED');
    if (typeof initial !== 'string' || !initial) {
      if (readingCatalogGeneration !== generation) fail('MODEL_CATALOG_CHANGED');
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
      if (readingGeneration !== identityGeneration || latest !== initial) fail('MODEL_CATALOG_CHANGED');
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
    state = { source: 'account', scope, state: 'loading', error: null, updatedAt: null };
    models = [];
    current.promise = (async () => {
      const resolved = await waitFor(resolveIdentity(requestSignal), requestSignal);
      if (generation !== current.generation) fail('MODEL_CATALOG_CHANGED');
      if (typeof resolved !== 'string' || !resolved) fail('MISSING_CREDENTIAL');
      // Official refresh may rotate this grant. Adopt it within this flight without
      // invalidating the callers sharing it, then fence the final metadata by that grant.
      initial = resolved;
      owner = resolved;
      current.resolving = false;
      const next = validatedModels(await waitFor(loadModels({ identity: initial, signal: requestSignal }), requestSignal));
      const latest = await waitFor(readIdentity(requestSignal), requestSignal);
      if (generation !== current.generation || latest !== initial) fail('MODEL_CATALOG_CHANGED');
      requestSignal.throwIfAborted();
      models = next;
      checkedAt = Date.now();
      state = { source: 'account', scope, state: 'ready', error: null, updatedAt: checkedAt };
      onChange();
    })().catch(error => {
      const code = generation !== current.generation ? 'MODEL_CATALOG_CHANGED'
        : error instanceof SubscriptionError ? error.code : 'MODEL_CATALOG_FAILED';
      if (generation === current.generation) {
        models = [];
        checkedAt = Date.now();
        state = { source: 'account', scope, state: 'error', error: code, updatedAt: null };
        onChange();
      }
      throw new SubscriptionError(code); // Never expose bodies, headers, credentials or upstream messages.
    }).finally(() => { if (flight === current) flight = undefined; });
    return waitFor(current.promise, signal);
  }
  return { ensure, clear, getModels: () => models, status: () => ({ ...state }) };
}
