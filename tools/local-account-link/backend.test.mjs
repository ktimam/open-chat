// Dependency-free tests of the real adapter source with inert SDK transport/signing doubles.
// Run: node --experimental-vm-modules --test source/backend.test.mjs
// These tests do not prove IC wire serialization, certification, or real WebAuthn behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { serialize, deserialize } from 'node:v8';
import * as policy from './policy.mjs';
import * as diagnostics from './diagnostics.mjs';

const metadata = {
  credentialId: [1, 2, 3], publicKey: [6, 7, 8], crossPlatform: false,
  aaguid: Array(16).fill(0), origin: 'localhost',
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function harness({ pauseGenerateAt, pauseAgentAt, quickDeadline = false, replies = {} } = {}) {
  const source = await readFile(new URL('./backend.mjs', import.meta.url), 'utf8');
  const calls = [], agentOptions = [], assertions = [];
  const keyPause = deferred(), agentPause = deferred();
  let keys = 0, agents = 0, updateId = 0;
  const updates = new Map();
  const encode = value => new Uint8Array(serialize(value));
  const decode = value => deserialize(Buffer.from(value));
  const ready = () => ({ user_key: [10, 20], expiration: BigInt(Date.now() + 300000) * 1000000n });
  const publicKey = value => ({ toDer: () => Uint8Array.from(value) });
  const identity = number => ({
    keyNumber: number,
    getPublicKey: () => publicKey([41, number]),
    getPrincipal: () => ({ toText: () => `temporary-${number}` }),
  });
  const responseFor = entry => {
    if (Object.hasOwn(replies, entry.method)) {
      const reply = replies[entry.method];
      return typeof reply === 'function' ? reply(entry) : reply;
    }
    switch (entry.method) {
      case 'verify_account_linking_code': return { Success: 'alice' };
      case 'finalise_account_linking_with_code':
      case 'prepare_delegation': return { Success: ready() };
      case 'check_auth_principal_v2': return { Success: { user_id: [11] } };
      case 'get_delegation': return { Success: {
        delegation: { pubkey: entry.args.session_key, expiration: entry.args.expiration }, signature: [31],
      } };
      case 'current_user': return { Success: { username: 'alice', user_id: [11] } };
      default: throw new Error(`Unexpected RPC in test: ${entry.method}`);
    }
  };
  const record = (mode, agentId, canister, request) => {
    assert.ok(request.methodName.endsWith('_msgpack'));
    const entry = {
      mode, agentId, canister: canister.toText(), method: request.methodName.replace(/_msgpack$/, ''),
      args: decode(request.arg), request,
    };
    calls.push(entry);
    return entry;
  };
  const HttpAgent = {
    async create(options) {
      const id = ++agents;
      agentOptions.push(options);
      if (id === pauseAgentAt) await agentPause.promise;
      return {
        async call(canister, request) {
          const entry = record('update', id, canister, request);
          assert.equal(request.callSync, false);
          assert.equal(request.effectiveCanisterId.toText(), canister.toText());
          const requestId = ++updateId;
          updates.set(requestId, entry);
          return { response: { status: 202 }, requestId };
        },
        async query(canister, request) {
          const entry = record('query', id, canister, request);
          return { status: 'replied', reply: { arg: encode(responseFor(entry)) } };
        },
      };
    },
  };
  const sdkIdentity = {
    ECDSAKeyIdentity: {
      async generate() {
        const number = ++keys;
        if (number === pauseGenerateAt) await keyPause.promise;
        return identity(number);
      },
    },
    WebAuthnIdentity: class {
      constructor(id, cose) { this.id = id; this.cose = cose; }
      getPublicKey() { return publicKey(this.cose); }
    },
    Delegation: class {
      constructor(pubkey, expiration) { this.pubkey = pubkey; this.expiration = expiration; }
    },
    DelegationChain: {
      async create(passkey, key, expiration) {
        assertions.push({ passkey, key, expiration });
        return { kind: 'passkey-auth' };
      },
      fromDelegations(delegations, key) { return { kind: 'openchat-session', delegations, key }; },
    },
    DelegationIdentity: {
      fromDelegation(session, chain) {
        return { session, chain, getPrincipal: () => ({ toText: () => chain.kind === 'openchat-session' ? 'existing-oc-principal' : 'fresh-auth-principal' }) };
      },
    },
  };
  const Principal = {
    fromText(value) {
      if (typeof value !== 'string' || !value) throw new Error('Invalid principal');
      return { toText: () => value };
    },
    fromUint8Array(value) { return { toText: () => `user-${Array.from(value).join('-')}` }; },
    selfAuthenticating(value) {
      assert.deepEqual(Array.from(value), metadata.publicKey);
      return { toUint8Array: () => new Uint8Array([77]) };
    },
  };
  const context = vm.createContext({ Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder, Date, BigInt,
    setTimeout: (fn, ms) => setTimeout(fn, quickDeadline && ms === 45000 ? 5 : ms), clearTimeout, AbortController });
  const exportsByName = {
    '@icp-sdk/core/agent': {
      HttpAgent, DER_COSE_OID: 'mock-der-cose-oid', unwrapDER: value => value,
      polling: { async pollForResponse(_agent, canister, id) {
        const entry = updates.get(id);
        assert.equal(canister.toText(), entry.canister);
        return { reply: encode(responseFor(entry)) };
      } },
    },
    '@icp-sdk/core/identity': sdkIdentity,
    '@icp-sdk/core/principal': { Principal },
    'msgpackr': { Packr: class { pack(value) { return encode(value); } unpack(value) { return decode(value); } } },
    './policy.mjs': policy,
    './diagnostics.mjs': diagnostics,
    './picker-passkey.mjs': { PickerWebAuthnIdentity: sdkIdentity.WebAuthnIdentity },
  };
  const module = new vm.SourceTextModule(source, { context, identifier: 'mocked-backend.mjs' });
  await module.link(specifier => {
    const exports = exportsByName[specifier];
    assert.ok(exports, `Unexpected import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return {
    adapter: new module.namespace.LocalIdentityAdapter(), calls, agentOptions, assertions,
    releaseKey: keyPause.resolve, releaseAgent: agentPause.resolve,
  };
}

test('clearing during delayed key generation must not consume the official linking code', async () => {
  const h = await harness({ pauseGenerateAt: 1 });
  const verification = h.adapter.verify('SYNTHETIC-CODE');
  h.adapter.clearSession();
  h.releaseKey();
  await assert.rejects(verification, /cancelled/);
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.adapter.finalize(metadata), /expired/);
});

test('verification deadline prevents a late key setup from submitting the code', async () => {
  const h = await harness({pauseGenerateAt:1, quickDeadline:true});
  await assert.rejects(h.adapter.verify('SYNTHETIC-CODE'), error => error.phase === 'key-setup' && error.reason === 'timeout');
  h.releaseKey(); await tick();
  assert.equal(h.calls.length, 0);
});

test('certified business rejection survives transport as safe numeric diagnostic', async () => {
  const h = await harness({ replies: {verify_account_linking_code:{Error:[342, 'untrusted private text']}} });
  await assert.rejects(h.adapter.verify('SYNTHETIC-CODE'), error => {
    assert.equal(error.appCode, 342); assert.equal(error.phase, 'reply');
    assert.doesNotMatch(JSON.stringify(error), /private|SYNTHETIC/); return true;
  });
});

test('clearing during delayed agent setup must not consume the linking code', async () => {
  const h = await harness({ pauseAgentAt: 1 });
  const verification = h.adapter.verify('SYNTHETIC-CODE');
  await tick();
  h.adapter.clearSession();
  h.releaseAgent();
  await assert.rejects(verification, /cancelled/);
  assert.equal(h.calls.length, 0);
});

test('finalization pins exact fields, caller agent, production canister and five-minute TTL', async () => {
  const h = await harness();
  const verified = await h.adapter.verify('SYNTHETIC-CODE');
  assert.equal(verified.username, 'alice');
  const result = await h.adapter.finalize(metadata);
  assert.deepEqual({ ...result }, { username: 'alice', userId: 'user-11', ocPrincipal: 'existing-oc-principal' });
  const verify = h.calls.find(call => call.method === 'verify_account_linking_code');
  const finalise = h.calls.find(call => call.method === 'finalise_account_linking_with_code');
  assert.equal(finalise.agentId, verify.agentId);
  assert.equal(finalise.mode, 'update');
  assert.equal(finalise.canister, policy.IDENTITY);
  assert.equal(finalise.args.max_time_to_live, 300000000000n);
  assert.deepEqual(Object.keys(finalise.args).sort(), ['max_time_to_live', 'principal', 'public_key', 'session_key', 'webauthn_key']);
  assert.deepEqual(Array.from(finalise.args.principal), [77]);
  assert.deepEqual(Array.from(finalise.args.public_key), metadata.publicKey);
  assert.deepEqual(Array.from(finalise.args.session_key), [41, 2]);
  assert.deepEqual(Object.keys(finalise.args.webauthn_key).sort(), ['aaguid', 'credential_id', 'cross_platform', 'origin', 'public_key']);
  assert.equal(finalise.args.webauthn_key.origin, 'localhost');
  assert.equal(finalise.args.webauthn_key.cross_platform, false);
  assert.deepEqual(Array.from(finalise.args.webauthn_key.credential_id), metadata.credentialId);
  assert.deepEqual(Array.from(finalise.args.webauthn_key.public_key), metadata.publicKey);
  assert.deepEqual(Array.from(finalise.args.webauthn_key.aaguid), metadata.aaguid);
  assert.deepEqual(h.calls.map(call => call.method), ['verify_account_linking_code', 'finalise_account_linking_with_code', 'get_delegation', 'current_user']);
  assert.equal(h.calls.at(-1).canister, policy.USER_INDEX);
  for (const options of h.agentOptions) {
    assert.equal(options.host, policy.HOST);
    assert.equal(options.verifyQuerySignatures, true);
    assert.equal(options.retryTimes, 0);
  }
  // A second call cannot silently repeat the consumed finalization write.
  await assert.rejects(h.adapter.finalize(metadata), /expired/);
  assert.equal(h.calls.filter(call => call.method === 'finalise_account_linking_with_code').length, 1);
});

test('clearing during finalization session-key setup prevents the write', async () => {
  const h = await harness({ pauseGenerateAt: 2 });
  await h.adapter.verify('SYNTHETIC-CODE');
  const finalization = h.adapter.finalize(metadata);
  h.adapter.clearSession();
  h.releaseKey();
  await assert.rejects(finalization, /cancelled/);
  assert.deepEqual(h.calls.map(call => call.method), ['verify_account_linking_code']);
});

test('finalization failure has no automatic retry or fallback account creation', async () => {
  const h = await harness({ replies: {
    finalise_account_linking_with_code: () => { throw new Error('synthetic sensitive SDK error'); },
  } });
  await h.adapter.verify('SYNTHETIC-CODE');
  await assert.rejects(h.adapter.finalize(metadata), error => /outcome may be unknown/.test(error.message) && !/sensitive/.test(error.message));
  await assert.rejects(h.adapter.finalize(metadata), /expired/);
  assert.deepEqual(h.calls.map(call => call.method), ['verify_account_linking_code', 'finalise_account_linking_with_code']);
});

test('fresh sign-in always asserts the passkey and rejects mismatched identity mappings', async () => {
  const h = await harness({ replies: { current_user: { Success: { username: 'alice', user_id: [12] } } } });
  await assert.rejects(h.adapter.freshSignIn(metadata), error => error instanceof diagnostics.SignInFailure && error.step === 'account-profile');
  assert.equal(h.assertions.length, 1);
  assert.deepEqual(h.calls.map(call => call.method), ['check_auth_principal_v2', 'prepare_delegation', 'get_delegation', 'current_user']);
  const prepare = h.calls.find(call => call.method === 'prepare_delegation');
  assert.equal(prepare.args.max_time_to_live, policy.TTL_NS);
  assert.equal(prepare.args.is_ii_principal, false);
  assert.equal(prepare.canister, policy.IDENTITY);
  assert.equal(h.calls.some(call => /create_identity|register|send_message|finalise_account/.test(call.method)), false);
});

test('an unknown or unmapped passkey never falls back to registration', async () => {
  for (const response of ['NotFound', { Success: { user_id: undefined } }]) {
    const h = await harness({ replies: { check_auth_principal_v2: response } });
    await assert.rejects(h.adapter.freshSignIn(metadata));
    assert.deepEqual(h.calls.map(call => call.method), ['check_auth_principal_v2']);
  }
});

test('fresh sign-in succeeds with matching mapping and uses a new assertion on each call', async () => {
  const h = await harness();
  const one = await h.adapter.freshSignIn(metadata);
  const two = await h.adapter.freshSignIn(metadata);
  assert.deepEqual({ ...one }, { username: 'alice', userId: 'user-11', ocPrincipal: 'existing-oc-principal' });
  assert.deepEqual({ ...two }, { ...one });
  assert.equal(h.assertions.length, 2);
  assert.notEqual(h.assertions[0].key, h.assertions[1].key);
  assert.equal(h.calls.filter(call => call.mode === 'update').every(call => call.method === 'prepare_delegation'), true);
});

test('clearing while fresh-login key setup is pending does not open a late passkey prompt', async () => {
  const h = await harness({pauseGenerateAt:1});
  const login = h.adapter.freshSignIn(metadata);
  h.adapter.clearSession(); h.releaseKey();
  await assert.rejects(login, error => error.step === 'session-key');
  assert.equal(h.assertions.length, 0); assert.equal(h.calls.length, 0);
});

test('long-lived returned delegation is rejected before delegated account lookup', async () => {
  const h = await harness({ replies: {
    finalise_account_linking_with_code: { Success: { user_key: [10, 20], expiration: BigInt(Date.now() + 86400000) * 1000000n } },
  } });
  await h.adapter.verify('SYNTHETIC-CODE');
  await assert.rejects(h.adapter.finalize(metadata), /Unexpected delegation lifetime/);
  assert.equal(h.calls.some(call => call.method === 'get_delegation' || call.method === 'current_user'), false);
});
