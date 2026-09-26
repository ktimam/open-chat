import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationInput } from './verification-input.mjs';
test('missing username and missing code identify their own fields', () => {
  assert.equal(verificationInput('', 'ABC123').field, 'username');
  assert.match(verificationInput('alice', '').message, /code field is empty/);
});
test('copy separators, direction marks and case normalize without truncation', () => {
  assert.deepEqual(verificationInput(' alice ', '\u200f ab c-123\u200e '), {username:'alice',code:'ABC123'});
  const result = verificationInput('alice', 'ABC1234');
  assert.equal(result.field, 'code'); assert.match(result.message, /7 characters/);
});
test('invalid alphabet and short code errors do not reveal entered code or guess aliases', () => {
  for (const code of ['ABC12', 'ABC12I', 'ABC12L', 'ABC12O', 'ABC12U', 'ABC12ſ', 'ABC1ß']) {
    const result = verificationInput('alice', code);
    assert.equal(result.field, 'code'); assert.equal(result.code, undefined);
    assert.ok(!result.message.includes(code));
  }
});
