// Offline contract checks using the pinned, installed SDK and MessagePack codec.
// Every fetch is replaced with an inert in-process responder before adapter use.
// These tests cannot prove production certification or successful account linking.
// Run: node --test real-sdk.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { Cbor, IC_REQUEST_DOMAIN_SEPARATOR, requestIdOf } from '@icp-sdk/core/agent';
import { Principal } from '@icp-sdk/core/principal';
import { WebAuthnIdentity } from '@icp-sdk/core/identity';
import { Packr } from 'msgpackr';
import { LocalIdentityAdapter } from './backend.mjs';
import { HOST, IDENTITY } from './policy.mjs';

const codec = new Packr({ useRecords: false, skipValues: [null, undefined], largeBigIntToString: true, copyBuffers: true });
const syntheticCode = 'SYNTHETIC-NOT-A-LINKING-CODE';
const callPath = `/api/v2/canister/${IDENTITY}/call`;
const readStatePath = `/api/v2/canister/${IDENTITY}/read_state`;
const byteArray = value => Uint8Array.from(value);

function inertFetch(t, respond) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    // There is deliberately no saved/native fetch or network fallback here.
    const url = new URL(String(input));
    assert.equal(url.origin, HOST);
    assert.equal(init.method, 'POST');
    assert.ok(init.body instanceof Uint8Array);
    const request = { path: url.pathname, envelope: Cbor.decode(byteArray(init.body)) };
    requests.push(request);
    return respond(request, requests.length);
  });
  return requests;
}

async function checkSignedEnvelope(envelope) {
  assert.ok(envelope.sender_pubkey instanceof Uint8Array);
  assert.equal(envelope.sender_pubkey.length, 91, 'the real SDK emits a P-256 SPKI public key');
  assert.equal(envelope.sender_sig.length, 64);
  assert.deepEqual(byteArray(envelope.content.sender), Principal.selfAuthenticating(envelope.sender_pubkey).toUint8Array());
  const publicKey = await webcrypto.subtle.importKey('spki', envelope.sender_pubkey,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const requestId = requestIdOf(envelope.content);
  const signedBytes = new Uint8Array(IC_REQUEST_DOMAIN_SEPARATOR.length + requestId.length);
  signedBytes.set(IC_REQUEST_DOMAIN_SEPARATOR);
  signedBytes.set(requestId, IC_REQUEST_DOMAIN_SEPARATOR.length);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' },
    publicKey, envelope.sender_sig, signedBytes), true, 'the actual SDK signature binds the unchanged wire request');
}

function checkVerificationRequest(request) {
  assert.equal(request.path, callPath);
  const content = request.envelope.content;
  assert.equal(content.request_type, 'call');
  assert.equal(content.method_name, 'verify_account_linking_code_msgpack');
  assert.deepEqual(byteArray(content.canister_id), Principal.fromText(IDENTITY).toUint8Array());
  assert.deepEqual(codec.unpack(content.arg), { code: syntheticCode });
  assert.deepEqual(byteArray(content.arg), byteArray(codec.pack({ code: syntheticCode })));
  assert.equal(typeof content.ingress_expiry, 'bigint');
}

test('real adapter and SDK sign the exact verify payload once and do not retry a transport failure', async t => {
  const requests = inertFetch(t, request => {
    checkVerificationRequest(request);
    throw new Error(`Synthetic transport exception containing ${syntheticCode}`);
  });
  const adapter = new LocalIdentityAdapter();
  await assert.rejects(adapter.verify(syntheticCode), error => {
    assert.equal(error instanceof Error, true);
    assert.equal(error.message.includes(syntheticCode), false);
    return true;
  });
  assert.equal(requests.length, 1, 'an uncertain submission is never repeated automatically');
  await checkSignedEnvelope(requests[0].envelope);
  await assert.rejects(adapter.finalize({}), /expired/i);
});

test('real SDK accepts asynchronous submission, signs read-state, and rejects an uncertified confirmation', async t => {
  const requests = inertFetch(t, (request, count) => {
    if (count === 1) {
      checkVerificationRequest(request);
      return new Response(null, { status: 202 });
    }
    assert.equal(count, 2, 'invalid certification must not cause a second submission');
    assert.equal(request.path, readStatePath);
    // A structurally invalid certificate is intentional. Never disable certificate
    // verification or stub polling/identity code just to manufacture success.
    return new Response(Cbor.encode({ certificate: Uint8Array.of(0) }), { status: 200 });
  });
  const adapter = new LocalIdentityAdapter();
  await assert.rejects(adapter.verify(syntheticCode));
  assert.equal(requests.length, 2);
  assert.equal(requests.filter(request => request.path === callPath).length, 1);
  const submission = requests[0].envelope;
  const confirmation = requests[1].envelope;
  await checkSignedEnvelope(submission);
  await checkSignedEnvelope(confirmation);
  assert.equal(confirmation.content.request_type, 'read_state');
  assert.deepEqual(byteArray(confirmation.sender_pubkey), byteArray(submission.sender_pubkey));
  assert.deepEqual(confirmation.content.paths.map(path => path.map(byteArray)), [[
    new TextEncoder().encode('request_status'), byteArray(requestIdOf(submission.content)),
  ]]);
  await assert.rejects(adapter.finalize({}), /expired/i);
});

test('real MessagePack codec decodes official verification success and numeric OCError tuple fixtures', () => {
  // Fixed MessagePack fixtures, not encode/decode round-trips or SDK doubles.
  // Rust identity/api/.../verify_account_linking_code.rs uses Success(String).
  const success = Uint8Array.from([
    0x81, 0xa7, 0x53, 0x75, 0x63, 0x63, 0x65, 0x73, 0x73,
    0xa5, 0x61, 0x6c, 0x69, 0x63, 0x65,
  ]);
  assert.deepEqual(codec.unpack(success), { Success: 'alice' });
  // backend/libraries/error_codes/src/lib.rs: OCError(u16, Option<String>),
  // LinkingCodeNotFound = 342. This preserves the wire error code as an integer.
  const linkingCodeNotFound = Uint8Array.from([
    0x81, 0xa5, 0x45, 0x72, 0x72, 0x6f, 0x72, 0x92, 0xcd, 0x01, 0x56, 0xc0,
  ]);
  assert.deepEqual(codec.unpack(linkingCodeNotFound), { Error: [342, null] });
  assert.equal(Number.isInteger(codec.unpack(linkingCodeNotFound).Error[0]), true);
});

test('real SDK passkey popup error is classified without making an account lookup', async t => {
  let requests = 0, assertions = 0;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{configurable:true,value:new URL('http://localhost:5187')});
  t.after(()=>{if(previousLocation) Object.defineProperty(globalThis,'location',previousLocation);else delete globalThis.location;});
  const original = Object.getOwnPropertyDescriptor(navigator, 'credentials');
  Object.defineProperty(navigator, 'credentials', {configurable:true,value:{get:async () => {
    assertions++; throw new DOMException('private provider detail', 'UnknownError');
  }}});
  t.after(() => { if (original) Object.defineProperty(navigator, 'credentials', original); else delete navigator.credentials; });
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('No network allowed'); });
  const identity = new WebAuthnIdentity(Uint8Array.of(1,2), Uint8Array.of(0xa0), undefined);
  await assert.rejects(new LocalIdentityAdapter().freshSignIn({origin:'localhost',credentialId:[1,2],publicKey:Array.from(identity.getPublicKey().toDer())}), error => {
    assert.equal(error.step, 'passkey-request'); assert.equal(error.reason, 'UnknownError');
    assert.doesNotMatch(JSON.stringify(error), /private provider detail/); return true;
  });
  assert.equal(assertions, 1); assert.equal(requests, 0);
});

for (const cancelled of [false,true]) test(`real adapter rejects ${cancelled ? 'a result after clearing' : 'another picker credential'} before backend contact`, async t=>{
  const previousLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{configurable:true,value:new URL('http://localhost:5187')});
  t.after(()=>{if(previousLocation)Object.defineProperty(globalThis,'location',previousLocation);else delete globalThis.location;});
  const previousCredentials=Object.getOwnPropertyDescriptor(navigator,'credentials');
  let release,entered;
  const pending=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  let suppliedOptions;
  Object.defineProperty(navigator,'credentials',{configurable:true,value:{get:options=>{
    suppliedOptions=options;entered();return pending;
  }}});
  t.after(()=>{if(previousCredentials)Object.defineProperty(navigator,'credentials',previousCredentials);else delete navigator.credentials;});
  t.mock.method(globalThis,'fetch',()=>{throw new Error('No backend request permitted');});
  const saved=new WebAuthnIdentity(Uint8Array.of(1,2),Uint8Array.of(0xa0),undefined);
  const adapter=new LocalIdentityAdapter();
  const result=adapter.freshSignIn({origin:'localhost',credentialId:[1,2],publicKey:Array.from(saved.getPublicKey().toDer())});
  await started;
  assert.equal(Object.hasOwn(suppliedOptions.publicKey,'allowCredentials'),false);
  assert.equal(suppliedOptions.publicKey.rpId,'localhost');
  assert.ok(suppliedOptions.publicKey.challenge.length>32,'the SDK delegation challenge is not replaced by random32');
  if(cancelled){adapter.clearSession();assert.equal(suppliedOptions.signal.aborted,true);}
  release({type:'public-key',rawId:Uint8Array.of(9)});
  await assert.rejects(result,error=>error.step==='passkey-request');
  assert.equal(globalThis.fetch.mock.callCount(),0);
});
