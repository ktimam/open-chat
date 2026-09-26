const phases = new Set(['key-setup', 'client-setup', 'encode', 'submit', 'confirm', 'decode', 'reply']);
const reasons = new Set(['timeout', 'network', 'http', 'protocol', 'cancelled']);
const signInSteps = new Set(['restore-credential', 'session-key', 'passkey-request', 'account-lookup', 'prepare-delegation', 'account-profile']);
const passkeyErrors = new Set(['NotAllowedError', 'SecurityError', 'UnknownError', 'AbortError', 'NotSupportedError', 'InvalidStateError']);
export class SignInFailure extends Error {
  constructor(step, error) {
    super('Fresh sign-in failed.');
    this.step = signInSteps.has(step) ? step : 'account-profile';
    this.reason = this.step === 'passkey-request' && passkeyErrors.has(error?.name) ? error.name : 'failed';
  }
}
export function signInFailure(error) {
  if (!(error instanceof SignInFailure)) return 'Fresh sign-in failed. Your saved credential is retained; do not relink yet. [SIGNIN/unknown]';
  const id = `SIGNIN/${error.step}/${error.reason}`;
  if (error.step === 'passkey-request') {
    return `The browser/passkey provider did not complete the passkey request (${error.reason}). OpenChat account lookup was not reached. Use the same browser and the localhost test passkey created during linking, not the official oc.app passkey. Your existing link has not been removed. [${id}]`;
  }
  if (['restore-credential', 'session-key'].includes(error.step)) {
    return `Fresh sign-in failed during local credential preparation. No passkey request or OpenChat account lookup was made. Your saved credential is retained. [${id}]`;
  }
  return `The passkey signed successfully, but the OpenChat ${error.step === 'account-lookup' ? 'account lookup' : error.step === 'prepare-delegation' ? 'session preparation' : 'account confirmation'} failed. Do not create another passkey or relink yet. [${id}]`;
}
export class ProbeFailure extends Error {
  constructor(phase, details = {}) {
    super('Account-link test failed.');
    this.phase = phases.has(phase) ? phase : 'reply';
    this.reason = reasons.has(details.reason) ? details.reason : 'protocol';
    if (Number.isInteger(details.httpStatus) && details.httpStatus >= 100 && details.httpStatus <= 599) this.httpStatus = details.httpStatus;
    if (Number.isInteger(details.appCode) && details.appCode >= 0 && details.appCode <= 65535) this.appCode = details.appCode;
  }
}
export function verificationFailure(error) {
  if (!(error instanceof ProbeFailure)) return 'Code verification failed; its outcome is unknown. Select “Start new verification” and obtain a fresh official code. Do not reuse this code.';
  const id = `VERIFY/${error.phase}/${error.reason}${error.httpStatus ? `/HTTP-${error.httpStatus}` : ''}${error.appCode !== undefined ? `/OC-${error.appCode}` : ''}`;
  if (error.phase === 'reply' && error.appCode === 342) {
    return `OpenChat rejected the code: it was not found, expired or already used. Select “Start new verification” and obtain a fresh official code. [${id}]`;
  }
  if (['key-setup', 'client-setup', 'encode'].includes(error.phase)) {
    return `Verification failed before the linking request was submitted. No code was consumed by this attempt. Select “Start new verification” to reset the page. [${id}]`;
  }
  if (error.phase === 'reply' && error.appCode !== undefined) {
    return `OpenChat rejected code verification. No account link was finalized. Select “Start new verification” and obtain a fresh official code. [${id}]`;
  }
  return `Verification ${error.reason === 'timeout' ? 'timed out' : 'failed'} during ${error.phase === 'submit' ? 'request submission' : 'response confirmation'}. The code may have been consumed; no account link was finalized. Select “Start new verification” and obtain a fresh official code. [${id}]`;
}
