import { LocalIdentityAdapter } from './backend.mjs';
import { AccountLinkProbe } from './controller.mjs';
import { assertLocalOrigin } from './policy.mjs';
import { publicRecord } from './public-storage.mjs';
import { verificationInput } from './verification-input.mjs';
import { checkSavedPasskey } from './local-passkey-check.mjs';

const $ = id => document.getElementById(id);
const storageKey = 'unofficial-openchat-local-proof-public-v1';
let probe, saved, expectedUsername, expectedUserId, expectedOcPrincipal;
let localCheckBusy = false;
function render(state) {
  const busy = localCheckBusy || ['verifying', 'linking', 'signing_in'].includes(state.stage);
  $('status').textContent = state.message;
  $('status').dataset.stage = state.stage;
  $('verify-status').textContent = state.message;
  $('verify-status').dataset.stage = state.stage;
  $('verify').textContent = state.stage === 'verifying' ? 'Verifying code… (up to 45 seconds)' : 'Verify code — do not link yet';
  $('reset-verification').hidden = Boolean(state.credential) || !['error', 'mismatch'].includes(state.stage);
  $('reset-verification').disabled = busy;
  $('verified-name').textContent = state.verifiedUsername ? `Verified account: ${state.verifiedUsername}` : 'No account verified.';
  $('verify').disabled = busy || Boolean(state.credential) || !['idle', 'cleared'].includes(state.stage);
  $('link').disabled = state.stage !== 'verified' || !$('consent').checked;
  $('consent').disabled = state.stage !== 'verified';
  $('signin').disabled = busy || !state.credential;
  $('local-passkey-check').disabled = busy || !state.credential;
  $('local-passkey-choose').disabled = busy || !state.credential;
  $('signin').textContent = state.stage === 'signing_in' ? 'Waiting for passkey and account check…' : 'Test fresh passkey sign-in';
  if (state.credential) $('signin-status').textContent = state.message;
  $('forget').disabled = busy;
  $('clear').disabled = busy;
  for (const id of ['username', 'expected-id', 'code']) $(id).disabled = $('verify').disabled;
  $('profile').replaceChildren();
  if (state.profile) {
    for (const [label, value] of [['Username', state.profile.username], ['OpenChat user ID', state.profile.userId], ['OpenChat principal', state.profile.ocPrincipal]]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label; dd.textContent = value; $('profile').append(dt, dd);
    }
    expectedUserId = state.profile.userId; expectedOcPrincipal = state.profile.ocPrincipal;
  }
  if (state.credential) {
    try {
      saved = publicRecord({ credential: state.credential, expectedUsername, expectedUserId, expectedOcPrincipal });
      localStorage.setItem(storageKey, JSON.stringify(saved));
    } catch { $('status').textContent += ' Public metadata could not be saved; do not reload before testing fresh sign-in.'; }
  }
}
function initialize() {
  assertLocalOrigin(location);
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) throw new Error('Passkeys unavailable');
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) saved = publicRecord(JSON.parse(raw));
  } catch { localStorage.removeItem(storageKey); }
  expectedUsername = saved?.expectedUsername;
  expectedUserId = saved?.expectedUserId;
  expectedOcPrincipal = saved?.expectedOcPrincipal;
  $('username').value = expectedUsername || '';
  $('expected-id').value = expectedUserId || '';
  probe = new AccountLinkProbe(new LocalIdentityAdapter(), render, saved);
  render(probe.state);
  $('verify').addEventListener('click', async () => {
    const input = verificationInput($('username').value, $('code').value);
    for (const id of ['username', 'code']) $(id).removeAttribute('aria-invalid');
    if (input.field) {
      $('verify-status').textContent = input.message;
      $('verify-status').dataset.stage = 'error';
      $(input.field).setAttribute('aria-invalid', 'true');
      $(input.field).focus();
      return;
    }
    $('code').value = '';
    expectedUsername = input.username; expectedUserId = $('expected-id').value.trim() || undefined;
    expectedOcPrincipal = undefined; $('consent').checked = false;
    await probe.verify(input.code, expectedUsername, expectedUserId);
  });
  $('consent').addEventListener('change', () => render(probe.state));
  $('link').addEventListener('click', async () => { if ($('consent').checked) await probe.link(); });
  $('signin').addEventListener('click', async () => { await probe.signIn(); });
  async function runLocalCheck(chooseCredential) {
    if (localCheckBusy || !probe.state.credential) return;
    localCheckBusy = true; render(probe.state);
    $('local-passkey-status').textContent = chooseCredential ? 'Choose the localhost test passkey in Edge. Only the returned credential ID will be compared; nothing is replaced or sent to OpenChat.' : 'Waiting for Edge to use the saved passkey locally. No OpenChat request will be made.';
    try { const result = await checkSavedPasskey(probe.state.credential, location.origin, chooseCredential); $('local-passkey-status').textContent = result.message; }
    finally { localCheckBusy = false; render(probe.state); }
  }
  $('local-passkey-check').addEventListener('click', () => runLocalCheck(false));
  $('local-passkey-choose').addEventListener('click', () => runLocalCheck(true));
  $('clear').addEventListener('click', () => { $('code').value = ''; $('consent').checked = false; probe.clear(); });
  $('reset-verification').addEventListener('click', () => { $('code').value = ''; $('consent').checked = false; probe.clear(); $('code').focus(); });
  $('forget').addEventListener('click', () => {
    probe.clear(); localStorage.removeItem(storageKey);
    saved = undefined; expectedUsername = undefined; expectedUserId = undefined; expectedOcPrincipal = undefined;
    $('code').value = ''; $('consent').checked = false;
    probe = new AccountLinkProbe(new LocalIdentityAdapter(), render); render(probe.state);
    $('status').textContent = 'Public details forgotten locally. This does not remove a passkey or unlink it from your real account.';
  });
  window.addEventListener('pagehide', () => probe.clear());
}
try { initialize(); } catch {
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  $('status').textContent = 'Open this page at http://localhost:5187 in a browser with passkey support. No authentication was attempted.';
}
