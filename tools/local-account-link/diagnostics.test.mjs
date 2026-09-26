import test from 'node:test';
import assert from 'node:assert/strict';
import { ProbeFailure, verificationFailure, SignInFailure, signInFailure } from './diagnostics.mjs';
import { AccountLinkProbe } from './controller.mjs';

test('verified business rejection is distinct from ambiguous transport failure', () => {
  const rejection = verificationFailure(new ProbeFailure('reply', { appCode: 342 }));
  assert.match(rejection, /not found, expired or already used/);
  assert.match(rejection, /OC-342/);
  const transport = verificationFailure(new ProbeFailure('submit', { reason: 'http', httpStatus: 403 }));
  assert.match(transport, /may have been consumed/);
  assert.match(transport, /VERIFY\/submit\/http\/HTTP-403/);
});
test('only pre-submission phases promise no consumption; confirmation timeout stays uncertain', () => {
  assert.match(verificationFailure(new ProbeFailure('key-setup')), /No code was consumed/);
  assert.match(verificationFailure(new ProbeFailure('confirm', {reason:'timeout'})), /timed out/);
  assert.match(verificationFailure(new ProbeFailure('confirm', {reason:'timeout'})), /may have been consumed/);
});
test('untrusted errors cannot leak request contents through diagnostics', () => {
  for (const error of [new Error('secret-code jwt privateKey'),
    { phase:'submit', message:'secret-code', httpStatus:'secret-code' },
    new ProbeFailure('secret-code', { reason:'privateKey', appCode:'secret-code', httpStatus:'secret-code' })]) {
    assert.doesNotMatch(verificationFailure(error), /secret-code|jwt|privateKey/);
  }
});
test('controller preserves only safe diagnostic and still refuses automatic verification retry', async () => {
  let calls = 0;
  const probe = new AccountLinkProbe({clearSession(){}, async verify(){ calls++; throw new ProbeFailure('reply', {appCode:342}); }});
  await probe.verify('secret-code', 'alice');
  assert.match(probe.state.message, /OC-342/);
  assert.doesNotMatch(JSON.stringify(probe.state), /secret-code/);
  await probe.verify('another-code', 'alice');
  assert.equal(calls, 1);
});

test('passkey-provider failure is distinguished from a successful signature and failed backend lookup', () => {
  const popup = signInFailure(new SignInFailure('passkey-request', {name:'UnknownError',message:'private credential details'}));
  assert.match(popup, /lookup was not reached/); assert.match(popup, /SIGNIN\/passkey-request\/UnknownError/);
  assert.doesNotMatch(popup, /private credential details/);
  const lookup = signInFailure(new SignInFailure('account-lookup', new Error('private credential details')));
  assert.match(lookup, /passkey signed successfully/); assert.match(lookup, /SIGNIN\/account-lookup\/failed/);
  assert.doesNotMatch(lookup, /private credential details/);
});

test('sign-in diagnostics never repeat arbitrary exception names or messages', () => {
  const message = signInFailure(new SignInFailure('passkey-request', {name:'secret-code',message:'private-key'}));
  assert.doesNotMatch(message, /secret-code|private-key/);
});
