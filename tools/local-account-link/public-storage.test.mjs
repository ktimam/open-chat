import test from 'node:test';
import assert from 'node:assert/strict';
import { publicRecord } from './public-storage.mjs';
import { allowedRequest } from './server.mjs';

test('persistent record copies only allowlisted public fields', () => {
  const record = publicRecord({ credential: { credentialId: [1], publicKey: [2], aaguid: Array(16).fill(0),
    origin: 'localhost', crossPlatform: false, privateKey: 'do-not-store' }, expectedUsername: ' Alice ',
    code: 'secret-code', proof_jwt: 'secret-token', session: 'secret-session' });
  assert.equal(record.expectedUsername, 'Alice');
  assert.doesNotMatch(JSON.stringify(record), /secret|privateKey|code|proof_jwt|session/);
});
test('malformed saved credential and identifiers fail closed', () => {
  const sample = { credential: { credentialId: [1], publicKey: [2], aaguid: Array(16).fill(0), origin: 'localhost', crossPlatform: false }, expectedUsername: 'Alice' };
  for (const bad of [null, {}, {...sample, expectedUsername: ''}, {...sample, expectedUserId: 123},
    {...sample, credential: {...sample.credential, origin: 'oc.app'}}, {...sample, credential: {...sample.credential, aaguid: [0]}}]) {
    assert.throws(() => publicRecord(bad));
  }
});
test('static server rejects other hosts, origins, methods, query strings and traversal', () => {
  const req = {method:'GET', url:'/', headers:{host:'localhost:5187'}};
  assert.equal(allowedRequest(req), true);
  for (const bad of [{...req,method:'POST'}, {...req,url:'/../backend.mjs'}, {...req,url:'/?code=secret'},
    {...req,headers:{host:'evil.example:5187'}}, {...req,headers:{host:'localhost:5187',origin:'https://evil.example'}}]) {
    assert.equal(allowedRequest(bad), false);
  }
});
