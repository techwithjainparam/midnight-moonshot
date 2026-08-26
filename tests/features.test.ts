// Focused tests for the new contact-verification (FEATURE 1) and
// document upload/extraction (FEATURE 2) logic. Pure logic, no DOM.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateEmail,
  normalizeMobile,
  validateContact,
  saveVerifiedProfile,
  getContactProfile,
  hasVerifiedProfile,
  deleteContactProfile,
} from '../src/profile/contact-verification';
import {
  createDemoOtp,
  verifyDemoOtp,
} from '../src/profile/demo-otp-provider';
import {
  getOtpProvider,
  setOtpProvider,
  type OtpProvider,
} from '../src/profile/otp-provider';
import type { UploadedDocumentMeta } from '../src/documents/types';
import {
  canViewDocument,
  getDocumentsVisibleTo,
  getDocumentsForOfficerReview,
  linkDocumentToApplication,
  getDocumentsForOwner,
  saveDocumentMeta,
} from '../src/documents/document-store';
import {
  defaultExtractionProvider,
  parseFileNameHints,
} from '../src/documents/extraction-provider';
import { applyExtractedFields } from '../src/documents/merge-extracted';

// ── Email / mobile validation ──────────────────────────────────────

test('email validation accepts realistic addresses and trims input', () => {
  assert.equal(validateEmail('asha.mehta@example.com'), null);
  assert.equal(validateEmail('  a+b@sub.domain.co.in  '), null);
});

test('email validation rejects empty, malformed and over-long values', () => {
  assert.ok(validateEmail(''));
  assert.ok(validateEmail('   '));
  assert.ok(validateEmail('not-an-email'));
  assert.ok(validateEmail('missing@tld'));
  assert.ok(validateEmail('two@@example.com'));
  assert.ok(validateEmail(`${'a'.repeat(250)}@example.com`));
});

test('mobile normalization strips formatting and yields E.164-style digits', () => {
  assert.equal(normalizeMobile('+91 98765 43210'), '+919876543210');
  assert.equal(normalizeMobile('+91-98765-43210'), '+919876543210');
  assert.equal(normalizeMobile('9876543210'), '+9876543210');
  assert.equal(normalizeMobile('(022) 1234 5678'), '+02212345678');
});

test('mobile validation enforces 10–15 digits', () => {
  assert.equal(normalizeMobile('12345'), null);
  assert.equal(normalizeMobile('abcdefghij'), null);
  assert.equal(normalizeMobile(''), null);
  assert.equal(normalizeMobile('1234567890123456'), null);
});

test('validateContact returns normalized value or a user-facing error', () => {
  const email = validateContact('email', ' asha@example.com ');
  assert.deepEqual(email, { value: 'asha@example.com', error: null });

  const mobile = validateContact('mobile', '+91 98765 43210');
  assert.deepEqual(mobile, { value: '+919876543210', error: null });

  assert.equal(validateContact('email', 'nope').value, null);
  assert.ok(validateContact('email', 'nope').error);
  assert.equal(validateContact('mobile', '123').value, null);
  assert.ok(validateContact('mobile', '123').error);
});

// ── Contact profile store ──────────────────────────────────────────

test('contact profile persists per wallet address and recognizes returning users', () => {
  const addr = 'wallet-profile-address';
  assert.equal(hasVerifiedProfile(addr), false);
  assert.equal(getContactProfile(addr), null);

  const saved = saveVerifiedProfile(addr.toUpperCase(), 'email', 'asha@example.com');
  assert.equal(saved.address, addr); // stored lower-cased
  assert.equal(hasVerifiedProfile(addr), true);

  const loaded = getContactProfile('  ' + addr.toUpperCase() + ' ');
  assert.equal(loaded?.contactType, 'email');
  assert.equal(loaded?.contactValue, 'asha@example.com');
  assert.ok(loaded?.verifiedAt);

  deleteContactProfile(addr);
  assert.equal(hasVerifiedProfile(addr), false);
});

// ── DEMO OTP behavior ──────────────────────────────────────────────

test('demo otp rejects verification when no code was issued', () => {
  assert.deepEqual(verifyDemoOtp('email', 'nobody@example.com', '123456'), {
    ok: false,
    reason: 'expired',
  });
});

test('demo otp verifies the correct code exactly once', () => {
  const contact = 'once@example.com';
  const otp = createDemoOtp('email', contact);
  assert.match(otp.code, /^\d{6}$/);

  assert.deepEqual(verifyDemoOtp('email', contact, ' wrong '), { ok: false, reason: 'invalid' });
  assert.deepEqual(verifyDemoOtp('email', contact, otp.code), { ok: true });
  // One-time use — the entry is consumed after success.
  assert.deepEqual(verifyDemoOtp('email', contact, otp.code), { ok: false, reason: 'expired' });
});

test('demo otp locks out after five incorrect attempts', () => {
  const otp = createDemoOtp('mobile', '+15550001234');

  for (let i = 1; i <= 4; i += 1) {
    assert.deepEqual(verifyDemoOtp('mobile', '+15550001234', '000000'), {
      ok: false,
      reason: 'invalid',
    });
  }
  // Fifth wrong attempt trips the lock-out…
  assert.deepEqual(verifyDemoOtp('mobile', '+15550001234', '000000'), {
    ok: false,
    reason: 'too-many-attempts',
  });
  // …and even the correct code no longer verifies afterwards.
  assert.notDeepEqual(verifyDemoOtp('mobile', '+15550001234', otp.code), { ok: true });
});

test('demo otp expires after its TTL', () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    mock.timers.setTime(0);
    const otp = createDemoOtp('email', 'ttl@example.com');
    assert.ok(otp.expiresAt > Date.now());

    mock.timers.setTime(otp.expiresAt + 1);
    assert.deepEqual(verifyDemoOtp('email', 'ttl@example.com', otp.code), {
      ok: false,
      reason: 'expired',
    });

    // A freshly issued code works again after expiry of the old one.
    mock.timers.setTime(otp.expiresAt + 2);
    const fresh = createDemoOtp('email', 'ttl@example.com');
    assert.deepEqual(verifyDemoOtp('email', 'ttl@example.com', fresh.code), { ok: true });
  } finally {
    mock.timers.reset();
  }
});

test('demo otp keys are case-insensitive per contact value', () => {
  const otp = createDemoOtp('email', 'Case@Example.com');
  assert.deepEqual(verifyDemoOtp('email', 'case@example.com', otp.code), { ok: true });
});

// ── OtpProvider architecture ────────────────────────────────────────

test('default OTP provider is the development fallback that never claims real delivery', async () => {
  const provider = getOtpProvider();
  assert.equal(provider.deliversRealCodes, false);

  const sent = await provider.sendOtp({ contactType: 'email', contactValue: 'provider@example.com' });
  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  // devCode is present precisely because nothing was actually delivered.
  assert.match(sent.challenge.devCode ?? '', /^\d{6}$/);
  assert.ok(sent.challenge.expiresAt > Date.now());

  const wrong = await provider.verifyOtp({ contactType: 'email', contactValue: 'provider@example.com' }, '000000');
  assert.deepEqual(wrong, { ok: false, reason: 'invalid' });
  const right = await provider.verifyOtp({ contactType: 'email', contactValue: 'provider@example.com' }, sent.challenge.devCode!);
  assert.deepEqual(right, { ok: true });
});

test('a custom OTP provider can be registered and is used by the app', async () => {
  const calls: string[] = [];
  const fakeBackend: OtpProvider = {
    name: 'test-backend',
    displayName: 'Test backend OTP',
    deliversRealCodes: true,
    sendOtp: async () => {
      calls.push('send');
      return { ok: true, challenge: { expiresAt: Date.now() + 60_000 } };
    },
    verifyOtp: async (_contact, code) => {
      calls.push('verify');
      return code === '424242' ? { ok: true } : { ok: false, reason: 'invalid' };
    },
  };

  setOtpProvider(fakeBackend);
  try {
    const provider = getOtpProvider();
    assert.equal(provider.name, 'test-backend');
    assert.equal(provider.deliversRealCodes, true); // UI may say "code was sent"

    const sent = await provider.sendOtp({ contactType: 'mobile', contactValue: '+15550009999' });
    assert.equal(sent.ok, true);
    if (!sent.ok) return;
    // A real provider never leaks the code into the challenge.
    assert.equal(sent.challenge.devCode, undefined);

    assert.deepEqual(
      await provider.verifyOtp({ contactType: 'mobile', contactValue: '+15550009999' }, '424242'),
      { ok: true },
    );
    assert.deepEqual(calls, ['send', 'verify']);
  } finally {
    setOtpProvider(null); // restore dev fallback
  }
});

// ── Document ownership / access control ────────────────────────────

function makeDoc(overrides: Partial<UploadedDocumentMeta> = {}): UploadedDocumentMeta {
  return {
    id: 'doc-test-1',
    ownerAddress: 'owner-wallet',
    fileName: 'sale-deed.pdf',
    fileType: 'application/pdf',
    fileSize: 2048,
    uploadedAt: new Date().toISOString(),
    extraction: {
      status: 'EXTRACTION_COMPLETE',
      fields: {},
      findings: [],
      provider: 'demo-local-filename',
    },
    ...overrides,
  };
}

const OWNER = { address: 'owner-wallet', isOfficer: false };
const OTHER_USER = { address: 'random-user', isOfficer: false };
const OFFICER = { address: 'officer-wallet', isOfficer: true };

test('document owner can always view their own document (case-insensitive)', () => {
  const doc = makeDoc();
  assert.equal(canViewDocument(doc, OWNER), true);
  assert.equal(canViewDocument(doc, { address: 'OWNER-WALLET', isOfficer: false }), true);
});

test('other users can never see someone else’s document', () => {
  const doc = makeDoc({ linkedApplicationId: 'reg-005' });
  assert.equal(canViewDocument(doc, OTHER_USER), false);
  assert.equal(canViewDocument(doc, { address: '', isOfficer: false }), false);
});

test('officers only access documents while the application is actively under review', () => {
  // reg-005 is SUBMITTED → under review → officer access granted.
  const active = makeDoc({ id: 'doc-active', linkedApplicationId: 'reg-005' });
  assert.equal(canViewDocument(active, OFFICER), true);

  // reg-001 is APPROVED (finalized) → officer access denied.
  const finalized = makeDoc({ id: 'doc-final', linkedApplicationId: 'reg-001' });
  assert.equal(canViewDocument(finalized, OFFICER), false);

  // Unlinked document — nothing under review → officer access denied.
  const unlinked = makeDoc({ id: 'doc-unlinked' });
  assert.equal(canViewDocument(unlinked, OFFICER), false);
});

test('getDocumentsVisibleTo filters a list to what the viewer may see', () => {
  const docs = [
    makeDoc({ id: 'doc-a', ownerAddress: 'owner-wallet' }),
    makeDoc({ id: 'doc-b', ownerAddress: 'someone-else' }),
    makeDoc({ id: 'doc-c', ownerAddress: 'someone-else', linkedApplicationId: 'reg-005' }),
  ];
  const forOwner = getDocumentsVisibleTo(docs, OWNER).map((d) => d.id);
  assert.deepEqual(forOwner, ['doc-a']);

  const forOfficer = getDocumentsVisibleTo(docs, OFFICER).map((d) => d.id);
  assert.deepEqual(forOfficer, ['doc-c']);

  assert.deepEqual(getDocumentsVisibleTo(docs, OTHER_USER), []);
});

test('officer review helper returns only documents linked to the application', () => {
  const docs = [
    makeDoc({ id: 'doc-x', ownerAddress: 'u1', linkedApplicationId: 'reg-005' }),
    makeDoc({ id: 'doc-y', ownerAddress: 'u2', linkedApplicationId: 'reg-005' }),
    makeDoc({ id: 'doc-z', ownerAddress: 'u3', linkedApplicationId: 'reg-001' }),
  ];
  assert.deepEqual(
    getDocumentsForOfficerReview('reg-005', docs).map((d) => d.id),
    ['doc-x', 'doc-y'],
  );
  // Finalized application exposes nothing to review.
  assert.deepEqual(getDocumentsForOfficerReview('reg-001', docs), []);
  // Unknown application exposes nothing.
  assert.deepEqual(getDocumentsForOfficerReview('reg-does-not-exist', docs), []);
});

test('document store keeps owners isolated and links documents per application', () => {
  const docA = makeDoc({ id: 'doc-owner-a', ownerAddress: 'wallet-a', fileName: 'a.pdf' });
  const docB = makeDoc({ id: 'doc-owner-b', ownerAddress: 'wallet-b', fileName: 'b.pdf' });
  saveDocumentMeta(docA);
  saveDocumentMeta(docB);

  assert.deepEqual(getDocumentsForOwner('WALLET-A').map((d) => d.id), ['doc-owner-a']);
  assert.deepEqual(getDocumentsForOwner('wallet-b').map((d) => d.id), ['doc-owner-b']);
  assert.deepEqual(getDocumentsForOwner('   '), []);

  linkDocumentToApplication('wallet-a', 'doc-owner-a', 'reg-app-42');
  assert.equal(getDocumentsForOwner('wallet-a')[0].linkedApplicationId, 'reg-app-42');
  assert.equal(getDocumentsForOwner('wallet-b')[0].linkedApplicationId, undefined);
});

// ── Extraction provider / status handling ──────────────────────────

async function extractName(name: string, type = 'application/pdf') {
  return defaultExtractionProvider.extract(new File([], name, { type }));
}

test('extraction marks unsupported files without throwing', async () => {
  const result = await extractName('notes.txt', 'text/plain');
  assert.equal(result.status, 'UNSUPPORTED_DOCUMENT');
  assert.deepEqual(result.fields, {});
  assert.equal(result.findings[0]?.severity, 'warning');
});

test('extraction reports missing information when fields cannot be read', async () => {
  const result = await extractName('property-document.pdf');
  assert.equal(result.status, 'MISSING_INFORMATION');
  assert.ok(result.findings.some((f) => f.severity === 'info'));
});

test('extraction flags potential inconsistency for conflicting identifiers', async () => {
  const result = await extractName('gat-10_cts-20_property.pdf');
  assert.equal(result.status, 'POTENTIAL_INCONSISTENCY');
  assert.ok(result.findings.some((f) => f.severity === 'warning'));
});

test('extraction completes when all core fields are readable', async () => {
  const result = await extractName('Gat-124_Asha-Mehta_2400sqft_pune.pdf');
  assert.equal(result.status, 'EXTRACTION_COMPLETE');
  assert.equal(result.fields.surveyNumber, 'Gat No. 124');
  assert.equal(result.fields.ownerName, 'Asha Mehta');
  assert.equal(result.fields.landArea, '2400 sq ft');
  assert.equal(result.fields.location, 'Pune');
  assert.ok(result.documentTypeLabel);
});

test('filename parsing is deterministic', async () => {
  const name = 'Gat-124_Asha-Mehta_2400sqft_pune.pdf';
  assert.deepEqual(parseFileNameHints(name), parseFileNameHints(name));
});

// ── Extracted fields never overwrite user-entered fields ───────────

const EMPTY_FORM = {
  ownerName: '',
  propertyType: 'Residential',
  surveyNumber: '',
  landArea: '',
  location: '',
  propertyValue: 0n,
};

const FULL_EXTRACTION = {
  ownerName: 'Asha Mehta',
  propertyType: 'Commercial',
  surveyNumber: 'Gat No. 124',
  landArea: '2400 sq ft',
  location: 'Pune',
  propertyValue: 'INR 24,50,000',
};

test('extracted fields fill empty form fields and report what was applied', () => {
  const { form, applied } = applyExtractedFields(EMPTY_FORM, FULL_EXTRACTION, new Set());
  assert.equal(form.ownerName, 'Asha Mehta');
  assert.equal(form.propertyType, 'Commercial');
  assert.equal(form.surveyNumber, 'Gat No. 124');
  assert.equal(form.landArea, '2400 sq ft');
  assert.equal(form.location, 'Pune');
  assert.equal(form.propertyValue, 2450000n);
  assert.deepEqual(
    [...applied].sort(),
    ['landArea', 'location', 'ownerName', 'propertyType', 'propertyValue', 'surveyNumber'],
  );
});

test('extracted fields do not overwrite user-entered (dirty) fields', () => {
  const dirty = new Set(['ownerName', 'propertyType', 'propertyValue']);
  const start = {
    ...EMPTY_FORM,
    ownerName: 'Typed By User',
    propertyType: 'Agricultural',
    propertyValue: 999n,
  };
  const { form, applied } = applyExtractedFields(start, FULL_EXTRACTION, dirty);

  assert.equal(form.ownerName, 'Typed By User'); // preserved
  assert.equal(form.propertyType, 'Agricultural'); // preserved
  assert.equal(form.propertyValue, 999n); // preserved
  assert.equal(applied.has('ownerName'), false);
  assert.equal(applied.has('propertyType'), false);
  assert.equal(applied.has('propertyValue'), false);
  // Untouched fields are still auto-filled.
  assert.equal(form.surveyNumber, 'Gat No. 124');
  assert.equal(form.location, 'Pune');
});

test('private property value only fills while untouched at zero', () => {
  const untouched = applyExtractedFields(EMPTY_FORM, { propertyValue: '12,00,000' }, new Set());
  assert.equal(untouched.form.propertyValue, 1200000n);
  assert.ok(untouched.applied.has('propertyValue'));

  const touched = applyExtractedFields(
    { ...EMPTY_FORM, propertyValue: 500n },
    { propertyValue: '12,00,000' },
    new Set(),
  );
  assert.equal(touched.form.propertyValue, 500n);
  assert.equal(touched.applied.has('propertyValue'), false);
});

test('garbage property value degrades to zero instead of crashing', () => {
  const { form } = applyExtractedFields(EMPTY_FORM, { propertyValue: 'not-a-number' }, new Set());
  assert.equal(form.propertyValue, 0n);
});
