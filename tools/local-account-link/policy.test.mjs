import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRpc, assertLocalOrigin, IDENTITY, USER_INDEX, TTL_NS, authDataToCose, bytes } from './policy.mjs';
test('only exact approved canister/method/mode pairs are permitted', () => {
  assert.doesNotThrow(() => assertRpc('update', IDENTITY, 'verify_account_linking_code'));
  assert.doesNotThrow(() => assertRpc('query', USER_INDEX, 'current_user'));
  for (const name of ['create_identity', 'register_user', 'send_message', 'delete_user', 'create_ai_app_card_provenance']) assert.throws(() => assertRpc('update', IDENTITY, name));
  assert.throws(() => assertRpc('query', IDENTITY, 'verify_account_linking_code'));
  assert.throws(() => assertRpc('update', USER_INDEX, 'verify_account_linking_code'));
  assert.equal(TTL_NS, 300000000000n);
});
test('origin never accepts another host, an unscoped URL, or code in the URL', () => {
  const local = new URL('http://localhost:5187/');
  assert.doesNotThrow(() => assertLocalOrigin(local));
  for (const value of ['http://127.0.0.1:5187/', 'https://oc.app/', 'http://localhost:5187/?code=ABC', 'http://localhost:5187/#secret', 'http://localhost.evil:5187/']) assert.throws(() => assertLocalOrigin(new URL(value)));
});
test('COSE extraction excludes authenticator extensions', () => {
  const data = new Uint8Array(64); data[32] = 64; data[54] = 2; data.set([1,2,0xa1,1,2,0xa1,1,2], 55);
  assert.deepEqual(authDataToCose(data), new Uint8Array([0xa1,1,2]));
});
test('COSE extraction rejects absent, malformed and truncated data', () => {
  assert.throws(() => authDataToCose(new Uint8Array(20)));
  for (const sequence of [[0xbf], [0xa1], [0xa1,1,0x5b,255,255,255,255,255,255,255,255]]) {
    const data = new Uint8Array(55 + sequence.length); data[32]=64; data.set(sequence,55); assert.throws(() => authDataToCose(data));
  }
});
test('binary metadata is bounded and copied', () => {
  const source = new Uint8Array([1,2]); const copied = bytes(source); source[0]=4; assert.equal(copied[0],1);
  for (const bad of [undefined,[],[-1],[256],[1.5],new Uint8Array(65537)]) assert.throws(() => bytes(bad));
});
