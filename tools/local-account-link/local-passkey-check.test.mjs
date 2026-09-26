import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSavedPasskey } from './local-passkey-check.mjs';
const metadata={origin:'localhost',credentialId:[1,2,3]};
function fixture(t, get) {
  const original=Object.getOwnPropertyDescriptor(navigator,'credentials');
  Object.defineProperty(navigator,'credentials',{configurable:true,value:{get}});
  t.after(()=>{if(original) Object.defineProperty(navigator,'credentials',original);else delete navigator.credentials;});
  t.mock.method(globalThis,'fetch',()=>{throw new Error('No network permitted');});
}
test('local diagnostic invokes credentials synchronously with saved ID and random32, without network',async t=>{
  let called=false;
  fixture(t,async options=>{
    called=true; assert.equal(options.publicKey.rpId,'localhost'); assert.equal(options.publicKey.challenge.length,32);
    assert.deepEqual(Array.from(options.publicKey.allowCredentials[0].id),[1,2,3]);
    const challenge=Buffer.from(options.publicKey.challenge).toString('base64url');
    const authData=new Uint8Array(37); authData.set(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('localhost'))));authData[32]=5;
    return {type:'public-key',rawId:new Uint8Array([1,2,3]),response:{clientDataJSON:new TextEncoder().encode(JSON.stringify({type:'webauthn.get',origin:'http://localhost:5187',challenge})),authenticatorData:authData,signature:new Uint8Array([1])}};
  });
  const resultPromise=checkSavedPasskey(metadata,'http://localhost:5187');assert.equal(called,true);
  const result=await resultPromise;assert.equal(result.ok,true);assert.match(result.message,/does not yet verify the signature/);
});
test('local diagnostic reports only safe failure name, never provider detail',async t=>{
  fixture(t,async()=>{throw new DOMException('secret provider data','NotAllowedError');});
  const result=await checkSavedPasskey(metadata,'http://localhost:5187');
  assert.equal(result.ok,false);assert.match(result.message,/LOCAL-PASSKEY\/NotAllowedError/);assert.doesNotMatch(result.message,/secret provider data/);
});
test('local diagnostic rejects another credential rather than replacing saved metadata',async t=>{
  fixture(t,async()=>({type:'public-key',rawId:new Uint8Array([9])}));
  assert.equal((await checkSavedPasskey(metadata,'http://localhost:5187')).ok,false);
  assert.deepEqual(metadata.credentialId,[1,2,3]);
});

test('explicit local picker omits ID filtering and reports a different ID without replacing it',async t=>{
  fixture(t,async options=>{
    assert.equal(Object.hasOwn(options.publicKey,'allowCredentials'),false);
    assert.equal(options.publicKey.rpId,'localhost');
    const challenge=Buffer.from(options.publicKey.challenge).toString('base64url');
    const authData=new Uint8Array(37);authData.set(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('localhost'))));authData[32]=1;
    return {type:'public-key',rawId:new Uint8Array([9]),response:{clientDataJSON:new TextEncoder().encode(JSON.stringify({type:'webauthn.get',origin:'http://localhost:5187',challenge})),authenticatorData:authData,signature:new Uint8Array([1])}};
  });
  const result=await checkSavedPasskey(metadata,'http://localhost:5187',true);
  assert.equal(result.ok,true);assert.equal(result.sameCredential,false);assert.match(result.message,/different-credential/);
  assert.deepEqual(metadata.credentialId,[1,2,3]);assert.equal(globalThis.fetch.mock.callCount(),0);
});

test('local picker cancellation does not retry or change saved ID',async t=>{
  let attempts=0;
  fixture(t,async()=>{attempts++;throw new DOMException('private details','NotAllowedError');});
  const result=await checkSavedPasskey(metadata,'http://localhost:5187',true);
  assert.equal(result.ok,false);assert.equal(attempts,1);assert.deepEqual(metadata.credentialId,[1,2,3]);assert.equal(globalThis.fetch.mock.callCount(),0);
});

test('diagnostic deadline is identified separately from provider cancellation',async t=>{
  let expire;
  t.mock.method(globalThis,'setTimeout',callback=>{expire=callback;return 1;});
  t.mock.method(globalThis,'clearTimeout',()=>{});
  fixture(t,options=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')))));
  const resultPromise=checkSavedPasskey(metadata,'http://localhost:5187',true);
  expire();
  const result=await resultPromise;
  assert.equal(result.ok,false);assert.match(result.message,/LOCAL-PASSKEY\/timeout/);
  assert.match(result.message,/does not identify the underlying provider error/);
  assert.equal(globalThis.clearTimeout.mock.callCount(),1);assert.equal(globalThis.fetch.mock.callCount(),0);
});
