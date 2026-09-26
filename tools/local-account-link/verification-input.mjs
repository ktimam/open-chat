// Accept copy/paste separators, but never guess ambiguous characters or truncate
// the normalized code. Only the backend's actual alphabet is submitted.
export function verificationInput(username, rawCode) {
  const name = username.trim();
  if (!name) return { field: 'username', message: 'The OpenChat username field is empty. Enter your existing username above. Nothing has been sent.' };
  const code = rawCode.replace(/[\s\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069-]/g, '');
  if (!code) return { field: 'code', message: 'The account-linking code field is empty. Paste the code from official OpenChat. Nothing has been sent.' };
  if (code.length !== 6) return { field: 'code', message: `The code has ${code.length} characters after removing spaces and separators; OpenChat account-linking codes require 6. Copy the complete account-linking code, not a sign-in or recovery code. Nothing has been sent.` };
  if (!/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/i.test(code)) return { field: 'code', message: 'The code contains a character that OpenChat account-linking codes do not use. Copy the code directly from official OpenChat; do not substitute letters or digits. Nothing has been sent.' };
  return { username: name, code: code.toUpperCase() };
}
