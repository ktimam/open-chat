// Offline contract tests: real SDK delegation/CBOR, synthetic keys and assertions.
// These do not prove that a real browser/provider or OpenChat accepts the sign-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signEc, verify as verifyEc, webcrypto } from 'node:crypto';
import { Cbor, requestIdOf, IC_REQUEST_AUTH_DELEGATION_DOMAIN_SEPARATOR, IC_REQUEST_DOMAIN_SEPARATOR } from '@icp-sdk/core/agent';
import { WebAuthnIdentity, ECDSAKeyIdentity, DelegationChain, DelegationIdentity } from '@icp-sdk/core/identity';
import { PickerWebAuthnIdentity } from './picker-passkey.mjs';

const origin = 'http://localhost:5187';
const id = Uint8Array.of(1, 2, 3, 4);
const cose = Uint8Array.of(0xa0);
const challenge = Uint8Array.from({ length: 59 }, (_, i) => i + 1);
const encode = value => new TextEncoder().encode(JSON.stringify(value));
const asBytes = value => new Uint8Array(value);
const concat = (...values) => Uint8Array.from(values.flatMap(value => Array.from(value)));
const sha256 = async value => asBytes(await webcrypto.subtle.digest('SHA-256', value));
const b64url = value => Buffer.from(value).toString('base64url');

function fixture(t, get, currentOrigin = origin) {
  const credentials = Object.getOwnPropertyDescriptor(navigator, 'credentials');
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL(currentOrigin) });
  let networkCalls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    networkCalls++;
    throw new Error('No network permitted in picker contract tests');
  });
  t.after(() => {
    if (credentials) Object.defineProperty(navigator, 'credentials', credentials);
    else delete navigator.credentials;
    if (location) Object.defineProperty(globalThis, 'location', location);
    else delete globalThis.location;
    assert.equal(networkCalls, 0, 'the identity must never make its own network requests');
  });
}

async function assertion(requestChallenge = challenge) {
  const authData = new Uint8Array(37);
  authData.set(await sha256(new TextEncoder().encode('localhost')));
  authData[32] = 5; // UP and UV.
  return {
    type: 'public-key', rawId: id.slice(), response: {
      clientDataJSON: encode({ type: 'webauthn.get', origin, challenge: b64url(requestChallenge), crossOrigin: false }),
      authenticatorData: authData,
      // Structural tests intentionally use an inert signature; the real-signature test is below.
      signature: Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01),
    },
  };
}

function editClientData(result, changes) {
  const data = JSON.parse(new TextDecoder().decode(result.response.clientDataJSON));
  result.response.clientDataJSON = encode({ ...data, ...changes });
}

test('picker retains exact SDK DER and challenge and uses same-ID discovery without ID filters', async t => {
  const controller = new AbortController();
  let called = false, returned;
  fixture(t, async options => {
    called = true;
    assert.equal(options.signal, controller.signal);
    assert.equal(Object.hasOwn(options.publicKey, 'allowCredentials'), false);
    assert.equal(options.publicKey.rpId, 'localhost');
    assert.equal(options.publicKey.userVerification, 'preferred');
    assert.equal(options.publicKey.timeout, 60000);
    assert.deepEqual(options.publicKey.challenge, challenge);
    returned = await assertion(options.publicKey.challenge);
    return returned;
  });
  const picker = new PickerWebAuthnIdentity(id, cose, controller.signal);
  const sdk = new WebAuthnIdentity(id, cose, undefined);
  assert.deepEqual(picker.getPublicKey().toDer(), sdk.getPublicKey().toDer());
  assert.equal(picker.getPrincipal().toText(), sdk.getPrincipal().toText());
  const pending = picker.sign(challenge);
  assert.equal(called, true, 'navigator.get must be invoked before the first await');
  const wire = Cbor.decode(await pending);
  assert.deepEqual(Object.keys(wire).sort(), ['authenticator_data', 'client_data_json', 'signature']);
  assert.deepEqual(wire.authenticator_data, returned.response.authenticatorData);
  assert.deepEqual(wire.signature, returned.response.signature);
  assert.equal(wire.client_data_json, new TextDecoder().decode(returned.response.clientDataJSON));
  assert.deepEqual(challenge, Uint8Array.from({ length: 59 }, (_, i) => i + 1));
});

const invalidCases = [
  ['different credential ID', value => { value.rawId = Uint8Array.of(9); }],
  ['empty credential ID', value => { value.rawId = new Uint8Array(); }],
  ['oversized credential ID', value => { value.rawId = new Uint8Array(4097); }],
  ['wrong credential type', value => { value.type = 'password'; }],
  ['wrong WebAuthn type', value => editClientData(value, { type: 'webauthn.create' })],
  ['wrong challenge', value => editClientData(value, { challenge: b64url(Uint8Array.of(9)) })],
  ['wrong origin', value => editClientData(value, { origin: 'https://example.invalid' })],
  ['wrong origin port', value => editClientData(value, { origin: 'http://localhost:5188' })],
  ['cross-origin assertion', value => editClientData(value, { crossOrigin: true })],
  ['wrong RP hash', value => { value.response.authenticatorData[0] ^= 1; }],
  ['missing user presence', value => { value.response.authenticatorData[32] = 4; }],
  ['short authenticator data', value => { value.response.authenticatorData = value.response.authenticatorData.slice(0, 36); }],
  ['empty signature', value => { value.response.signature = new Uint8Array(); }],
  ['oversized signature', value => { value.response.signature = new Uint8Array(1025); }],
  ['malformed client JSON', value => { value.response.clientDataJSON = new TextEncoder().encode('{'); }],
  ['invalid UTF-8', value => { value.response.clientDataJSON = Uint8Array.of(0xff); }],
  ['missing response', value => { delete value.response; }],
];

for (const [name, mutate] of invalidCases) {
  test(`picker rejects ${name} without retry or network`, async t => {
    let calls = 0;
    fixture(t, async () => {
      calls++;
      const result = await assertion();
      mutate(result);
      return result;
    });
    const savedId = id.slice();
    const picker = new PickerWebAuthnIdentity(savedId, cose);
    await assert.rejects(picker.sign(challenge));
    assert.equal(calls, 1);
    assert.deepEqual(savedId, id);
  });
}

test('picker rejects null rather than retrying or replacing a key', async t => {
  let calls = 0;
  fixture(t, async () => { calls++; return null; });
  await assert.rejects(new PickerWebAuthnIdentity(id, cose).sign(challenge));
  assert.equal(calls, 1);
});

test('preferred UV preserves SDK semantics when UP is present but UV is absent', async t => {
  fixture(t, async () => {
    const result = await assertion();
    result.response.authenticatorData[32] = 1;
    return result;
  });
  const wire = Cbor.decode(await new PickerWebAuthnIdentity(id, cose).sign(challenge));
  assert.equal(wire.authenticator_data[32], 1);
});

test('provider cancellation propagates once with no fallback', async t => {
  const failure = new DOMException('Synthetic cancellation', 'NotAllowedError');
  let calls = 0;
  fixture(t, async () => { calls++; throw failure; });
  await assert.rejects(new PickerWebAuthnIdentity(id, cose).sign(challenge), error => error === failure);
  assert.equal(calls, 1);
});

test('abort while picker is pending rejects the assertion', async t => {
  const controller = new AbortController();
  let calls = 0;
  fixture(t, options => {
    calls++;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
  });
  const pending = new PickerWebAuthnIdentity(id, cose, controller.signal).sign(challenge);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('late provider success after abort is rejected even if provider ignores signal', async t => {
  const controller = new AbortController();
  const result = await assertion();
  let release;
  fixture(t, () => new Promise(resolve => { release = resolve; }));
  const pending = new PickerWebAuthnIdentity(id, cose, controller.signal).sign(challenge);
  controller.abort();
  release(result);
  await assert.rejects(pending, { name: 'AbortError' });
});

test('abort during asynchronous RP validation cannot return a signature', async t => {
  const result = await assertion();
  const controller = new AbortController();
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', async (...args) => {
    const hash = await originalDigest(...args);
    controller.abort();
    return hash;
  });
  fixture(t, async () => result);
  await assert.rejects(new PickerWebAuthnIdentity(id, cose, controller.signal).sign(challenge), { name: 'AbortError' });
});

test('invalid local scope is rejected before opening the picker', async t => {
  let calls = 0;
  fixture(t, async () => { calls++; return null; }, 'http://127.0.0.1:5187');
  await assert.rejects(new PickerWebAuthnIdentity(id, cose).sign(challenge));
  assert.equal(calls, 0);
});

test('real SDK delegation and request wire retain a cryptographically valid synthetic WebAuthn assertion', async t => {
  // Synthetic, ephemeral test key only. No authenticator or real account is involved.
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  // Canonical COSE EC2 / ES256 / P-256 key with x and y coordinates.
  const realCose = concat(Uint8Array.of(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20),
    Buffer.from(jwk.x, 'base64url'), Uint8Array.of(0x22, 0x58, 0x20), Buffer.from(jwk.y, 'base64url'));
  let seenChallenge, signedResponse, calls = 0;
  fixture(t, async options => {
    calls++;
    assert.equal(Object.hasOwn(options.publicKey, 'allowCredentials'), false);
    seenChallenge = options.publicKey.challenge.slice();
    signedResponse = await assertion(seenChallenge);
    const response = signedResponse.response;
    response.signature = asBytes(signEc('sha256', concat(response.authenticatorData, await sha256(response.clientDataJSON)), privateKey));
    return signedResponse;
  });
  const picker = new PickerWebAuthnIdentity(id, realCose);
  const sdk = new WebAuthnIdentity(id, realCose, undefined);
  const session = await ECDSAKeyIdentity.generate();
  const expiration = new Date(Date.now() + 300000);
  const chain = await DelegationChain.create(picker, session.getPublicKey(), expiration);
  assert.equal(calls, 1);
  assert.deepEqual(chain.publicKey, sdk.getPublicKey().toDer());
  assert.equal(chain.delegations.length, 1);
  const signed = chain.delegations[0];
  assert.deepEqual(signed.delegation.pubkey, session.getPublicKey().toDer());
  assert.equal(signed.delegation.expiration, BigInt(+expiration) * 1000000n);
  const expectedChallenge = concat(IC_REQUEST_AUTH_DELEGATION_DOMAIN_SEPARATOR, requestIdOf({ ...signed.delegation }));
  assert.deepEqual(seenChallenge, expectedChallenge, 'the exact IC domain-separated delegation challenge is signed');
  assert.notEqual(seenChallenge.length, 32, 'a random32 diagnostic challenge must not replace the IC challenge');
  const decoded = Cbor.decode(signed.signature);
  assert.equal(decoded.client_data_json, new TextDecoder().decode(signedResponse.response.clientDataJSON));
  assert.deepEqual(decoded.authenticator_data, signedResponse.response.authenticatorData);
  assert.deepEqual(decoded.signature, signedResponse.response.signature);
  const payload = concat(decoded.authenticator_data, await sha256(new TextEncoder().encode(decoded.client_data_json)));
  assert.equal(verifyEc('sha256', payload, publicKey, decoded.signature), true);
  const changed = payload.slice(); changed[changed.length - 1] ^= 1;
  assert.equal(verifyEc('sha256', changed, publicKey, decoded.signature), false);

  const delegated = DelegationIdentity.fromDelegation(session, chain);
  const content = { request_type: 'query', method_name: 'synthetic', arg: Uint8Array.of(0),
    canister_id: Uint8Array.of(1), sender: picker.getPrincipal().toUint8Array(), ingress_expiry: 1000000000000n };
  const envelope = (await delegated.transformRequest({ body: content })).body;
  const wire = Cbor.decode(Cbor.encode(envelope));
  assert.deepEqual(wire.sender_pubkey, sdk.getPublicKey().toDer());
  assert.deepEqual(wire.sender_delegation[0].signature, signed.signature);
  assert.deepEqual(wire.sender_delegation[0].delegation.pubkey, asBytes(session.getPublicKey().toDer()));
  const sessionPublic = await webcrypto.subtle.importKey('spki', session.getPublicKey().toDer(), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, sessionPublic,
    wire.sender_sig, concat(IC_REQUEST_DOMAIN_SEPARATOR, requestIdOf(content))), true);
  assert.equal(calls, 1, 'delegated requests use the ephemeral session and do not trigger a second picker');
});
