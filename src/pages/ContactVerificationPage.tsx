import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ProductBanner from '../components/ProductBanner';
import { useAuth } from '../auth/AuthContext';
import {
  validateEmail,
  normalizeIndianMobile,
  getUserProfile,
  saveVerifiedProfile,
  recordAadhaarMobileVerified,
  deleteContactProfile,
  type UserProfile,
  type AadhaarMobileRecord,
} from '../profile/contact-verification';
import {
  contactVerificationProvider,
  identityVerificationProvider,
  AADHAAR_UNAVAILABLE_MESSAGE,
  VERIFICATION_UNAVAILABLE_MESSAGE,
} from '../profile/providers';

// FEATURE 1 — Contact & identity verification screen (REAL providers).
//
// Flow: Connect Wallet → first-time user? → verify at least ONE of:
//
//   • EMAIL          server-generated OTP delivered to the user's inbox;
//                     verified server-side. The code is never displayed
//                     in the browser and never stored client-side.
//   • AADHAAR MOBILE  an authorized identity/KYC provider confirms the
//                     mobile↔Aadhaar link (direct link check or an OTP
//                     challenge to the REGISTERED mobile). Success is
//                     claimed ONLY on the provider's confirmation.
//
// When the verification backend or its upstream providers are missing,
// the UI shows the honest "unavailable" state — it never falls back to
// a demo/mock flow and never fakes success.
export default function ContactVerificationPage() {
  const { address } = useAuth();
  const navigate = useNavigate();

  const [profile, setProfile] = useState<UserProfile | null>(null);

  // Returning user? Recognize the wallet and load the existing profile.
  useEffect(() => {
    if (!address) return;
    setProfile(getUserProfile(address));
  }, [address]);

  if (!address) {
    return (
      <div className="page profile-page">
        <ProductBanner />
        <div className="auth-gate">
          <h1 className="auth-gate-title">Connect your wallet to continue.</h1>
          <p className="auth-gate-desc">A connected Midnight wallet is required to verify your contact profile.</p>
          <Link to="/" className="btn btn-primary btn-lg">Return Home</Link>
        </div>
      </div>
    );
  }

  const anyVerified = Boolean(profile && (profile.email || profile.mobile || profile.aadhaarMobile?.verified));

  return (
    <div className="page profile-page">
      <ProductBanner />

      <div className="page-header">
        <h1 className="page-title">{anyVerified ? 'Verified Profile' : 'Complete Your Verification'}</h1>
        <p className="page-desc" style={{ maxWidth: 640 }}>
          Your connected wallet remains your primary PRIESTATE identity.
          Verify your email address or your Aadhaar-linked mobile number so
          we can notify you about registration updates, officer decisions,
          ownership transfers, and important alerts. Verification codes are
          sent and checked on our secure server — they are never shown in
          the browser.
        </p>
      </div>

      <div className="verify-grid">
        <EmailVerificationCard
          verified={profile?.email ?? null}
          onVerified={(value) => {
            if (!address) return;
            const saved = saveVerifiedProfile(address, 'email', value);
            setProfile((prev) => ({ ...(prev ?? { address }), email: { value: saved.contactValue, verifiedAt: saved.verifiedAt } }));
          }}
          onReset={anyVerified ? () => { deleteContactProfile(address); setProfile(null); } : undefined}
        />

        <AadhaarMobileCard
          record={profile?.aadhaarMobile ?? null}
          onVerified={(mobile, receipt) => {
            if (!address) return;
            const rec = recordAadhaarMobileVerified(address, {
              mobile,
              providerVerificationId: receipt.providerVerificationId,
              verificationStatus: receipt.verificationStatus,
            });
            setProfile((prev) => ({ ...(prev ?? { address }), aadhaarMobile: rec }));
          }}
          onReset={anyVerified ? () => { deleteContactProfile(address); setProfile(null); } : undefined}
        />
      </div>

      {anyVerified && (
        <div className="profile-card" style={{ marginTop: '1.5rem' }}>
          <div className="profile-steps" aria-label="Progress">
            <span className="profile-step done active">✓ Verified</span>
          </div>

          {profile?.email && (
            <VerifiedRow title="✓ Email verified" value={profile.email.value} />
          )}
          {!profile?.email && profile?.mobile && (
            <VerifiedRow title="✓ Mobile verified" value={profile.mobile.value} />
          )}
          {profile?.aadhaarMobile?.verified && (
            <VerifiedRow
              title="✓ Aadhaar-linked mobile verified"
              value={profile.aadhaarMobile.mobile ?? ''}
              note={`Provider ID ${profile.aadhaarMobile.providerVerificationId ?? ''}`}
            />
          )}

          <p className="profile-done-note">
            Notifications about registration updates, officer approval or
            rejection, ownership transfers, and important alerts will be sent
            to your verified contact(s). They stay private and never appear
            in the registry. No Aadhaar number is stored — only the provider
            verification reference.
          </p>

          <div className="profile-done-actions">
            <button className="btn btn-primary btn-lg" onClick={() => navigate('/dashboard')}>
              Continue to Dashboard
            </button>
            <button className="btn btn-primary btn-lg" onClick={() => navigate('/register')}>
              Continue to Registration
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => { deleteContactProfile(address); setProfile(null); }}
            >
              Reset Verification
            </button>
          </div>
        </div>
      )}

      <p className="profile-footnote">
        Wallet identity note: connecting your Midnight wallet authorizes all
        PRIESTATE actions. Verified contact details are an optional channel
        and can never authorize transactions on their own. Aadhaar-linked
        checks are performed by an authorized identity provider; PRIESTATE
        stores only the verification result and its reference ID.
      </p>
    </div>
  );
}

function VerifiedRow({ title, value, note }: { title: string; value: string; note?: string }) {
  return (
    <div className="profile-verified-row">
      <div className="profile-verified-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <div>
        <span className="profile-verified-title">{title}</span>
        <span className="profile-verified-value">{value}</span>
        {note && <span className="profile-verified-value" style={{ fontSize: '0.72rem' }}>{note}</span>}
      </div>
      <span className="status-pill status-registered">VERIFIED</span>
    </div>
  );
}

// ── Email card ───────────────────────────────────────────────────────

type EmailStep = 'input' | 'otp';

function EmailVerificationCard({
  verified,
  onVerified,
  onReset,
}: {
  verified: { value: string; verifiedAt: string } | null;
  onVerified: (value: string) => void;
  onReset?: () => void;
}) {
  const [step, setStep] = useState<EmailStep>('input');
  const [email, setEmail] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [cooldownEndsAt, setCooldownEndsAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const otpInputRef = useRef<HTMLInputElement>(null);

  // One shared ticker while any countdown is relevant.
  const counting = expiresAt !== null || cooldownEndsAt !== null;
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [counting]);

  const sendCode = useCallback(async (value: string) => {
    setSending(true);
    setSendError(null);
    try {
      const result = await contactVerificationProvider.sendEmailOtp(value);
      if (!result.ok) {
        switch (result.reason) {
          case 'unavailable':
            setSendError(VERIFICATION_UNAVAILABLE_MESSAGE);
            break;
          case 'cooldown':
          case 'rate-limited': {
            const waitS = Math.ceil((result.retryAfterMs ?? 60_000) / 1000);
            setSendError(`Please wait ${formatWait(waitS)} before requesting another code.`);
            break;
          }
          case 'invalid-email':
            setSendError('Enter a valid email address.');
            break;
          default:
            setSendError(result.message ?? 'Could not send the verification code. Try again.');
        }
        return;
      }
      setPendingValue(value);
      setExpiresAt(result.challenge.expiresAt);
      setCooldownEndsAt(result.challenge.resendAvailableAt);
      setCode('');
      setOtpError(null);
      setStep('otp');
      setTimeout(() => otpInputRef.current?.focus(), 50);
    } finally {
      setSending(false);
    }
  }, []);

  const handleSend = useCallback(() => {
    const error = validateEmail(email);
    if (error) {
      setInputError(error);
      return;
    }
    setInputError(null);
    void sendCode(email.trim());
  }, [email, sendCode]);

  const handleVerify = useCallback(async () => {
    if (!pendingValue) return;
    setVerifying(true);
    try {
      const result = await contactVerificationProvider.verifyEmailOtp(pendingValue, code);
      if (result.ok) {
        onVerified(pendingValue);
        setStep('input');
        setEmail('');
        setPendingValue(null);
        setExpiresAt(null);
        setCooldownEndsAt(null);
        return;
      }
      switch (result.reason) {
        case 'expired':
          setOtpError('This code has expired. Send a new code and try again.');
          break;
        case 'too-many-attempts':
          setOtpError('Too many incorrect attempts. Send a new code and try again.');
          break;
        case 'unavailable':
          setOtpError(VERIFICATION_UNAVAILABLE_MESSAGE);
          break;
        default:
          setOtpError('Incorrect code. Check the code sent to your email and try again.');
      }
    } finally {
      setVerifying(false);
    }
  }, [code, onVerified, pendingValue]);

  const resendBlockedForS =
    cooldownEndsAt !== null && nowTick < cooldownEndsAt ? Math.ceil((cooldownEndsAt - nowTick) / 1000) : 0;

  if (verified) {
    return (
      <section className="verify-card verify-card-done" aria-label="Email verification">
        <CardHeader icon="mail" title="Email" badge={<span className="status-pill status-registered">VERIFIED</span>} />
        <VerifiedInline label="✓ Email verified" value={verified.value} />
        {onReset && <button className="btn btn-ghost" style={{ marginTop: '1rem' }} onClick={onReset}>Reset Verification</button>}
      </section>
    );
  }

  return (
    <section className="verify-card" aria-label="Email verification">
      <CardHeader icon="mail" title="Email" />

      {step === 'input' ? (
        <>
          <div className="form-field">
            <label className="form-label" htmlFor="email-input">Email</label>
            <input
              id="email-input"
              type="email"
              inputMode="email"
              autoComplete="email"
              className={`form-input${inputError ? ' form-input-error' : ''}`}
              placeholder="user@example.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setInputError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
            />
            {inputError && <span className="form-error">{inputError}</span>}
            <span className="form-hint">Used only for application notifications. Never displayed publicly.</span>
          </div>

          {sendError && <div className="status-msg error" role="alert">{sendError}</div>}

          <button className="btn btn-primary btn-lg verify-card-btn" onClick={handleSend} disabled={sending}>
            {sending ? 'Sending…' : 'Send verification code'}
          </button>
        </>
      ) : (
        <>
          <p className="profile-otp-context">
            Enter the verification code sent to your email{' '}
            <strong>{pendingValue}</strong>.
          </p>

          {sendError && <div className="status-msg error" role="alert">{sendError}</div>}
          {expiresAt !== null && nowTick < expiresAt && (
            <p className="profile-otp-sent-note">
              The code expires {Math.ceil((expiresAt - nowTick) / 60000)} minute(s) after issue — request a new one if it does not arrive.
            </p>
          )}

          <div className="form-field">
            <label className="form-label" htmlFor="email-otp-input">Verification Code</label>
            <input
              id="email-otp-input"
              ref={otpInputRef}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className={`form-input profile-otp-input${otpError ? ' form-input-error' : ''}`}
              placeholder="_ _ _ _ _ _"
              value={code}
              onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setOtpError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleVerify(); }}
            />
            {otpError && <span className="form-error">{otpError}</span>}
          </div>

          <div className="profile-otp-actions">
            <button className="btn btn-primary" onClick={() => void handleVerify()} disabled={code.length !== 6 || verifying}>
              {verifying ? 'Verifying…' : 'Verify'}
            </button>
            <button className="btn btn-ghost" onClick={() => pendingValue && void sendCode(pendingValue)} disabled={sending || resendBlockedForS > 0}>
              {resendBlockedForS > 0 ? `Resend in ${formatWait(resendBlockedForS)}` : 'Resend code'}
            </button>
            <button className="btn btn-ghost" onClick={() => { setStep('input'); setOtpError(null); setSendError(null); }}>
              Change Email
            </button>
          </div>
        </>
      )}
    </section>
  );
}

// ── Aadhaar-linked mobile card ───────────────────────────────────────

type Step = 'input' | 'challenge';

function AadhaarMobileCard({
  record,
  onVerified,
  onReset,
}: {
  record: AadhaarMobileRecord | null;
  onVerified: (mobile: string, receipt: { providerVerificationId: string; verificationStatus: 'VERIFIED' }) => void;
  onReset?: () => void;
}) {
  const [step, setStep] = useState<Step>('input');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [mobile, setMobile] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notLinked, setNotLinked] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null);
  const [pendingMobile, setPendingMobile] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);

  // Ask the verification server once whether an authorized Aadhaar/KYC
  // provider is configured. If not, show the honest unavailable state —
  // there is no fallback and no fake success.
  useEffect(() => {
    let cancelled = false;
    identityVerificationProvider.isConfiguredOnServer().then((ok) => {
      if (!cancelled) setAvailable(ok);
    });
    return () => { cancelled = true; };
  }, []);

  const start = useCallback(async () => {
    const normalized = normalizeIndianMobile(mobile);
    if (!normalized) {
      setInputError('Enter a valid Indian mobile number (10 digits starting 6–9).');
      return;
    }
    setInputError(null);
    setActionError(null);
    setNotLinked(null);
    setBusy(true);
    try {
      const result = await identityVerificationProvider.startAadhaarMobileVerification(normalized);
      if (!result.ok) {
        setActionError(
          result.reason === 'unavailable'
            ? AADHAAR_UNAVAILABLE_MESSAGE
            : result.reason === 'invalid-mobile'
              ? 'Enter a valid Indian mobile number.'
              : result.message ?? 'The identity provider could not be reached. Try again.',
        );
        return;
      }
      if (result.mode === 'not-linked') {
        setNotLinked(result.message);
        return;
      }
      if (result.mode === 'otp-challenge') {
        setPendingMobile(normalized);
        setSessionId(result.session.id);
        setSessionExpiresAt(result.session.expiresAt);
        setCode('');
        setCodeError(null);
        setStep('challenge');
        return;
      }
      // Direct link-check confirmation from the authorized provider.
      onVerified(normalized, {
        providerVerificationId: result.receipt.providerVerificationId,
        verificationStatus: result.receipt.verificationStatus,
      });
      setAvailable(true);
    } finally {
      setBusy(false);
    }
  }, [mobile, onVerified]);

  const complete = useCallback(async () => {
    if (!sessionId || !pendingMobile) return;
    setBusy(true);
    setCodeError(null);
    try {
      const result = await identityVerificationProvider.verifyAadhaarMobileVerification({ sessionId, code });
      if (!result.ok) {
        switch (result.reason) {
          case 'expired':
            setCodeError('This verification session expired. Start again.');
            break;
          case 'too-many-attempts':
            setCodeError('Too many incorrect attempts. Start again.');
            break;
          case 'invalid-code':
            setCodeError('Incorrect code. Check the code sent to your registered mobile.');
            break;
          case 'unavailable':
            setCodeError(AADHAAR_UNAVAILABLE_MESSAGE);
            break;
          default:
            setCodeError(result.message ?? 'Verification failed. Try again.');
        }
        return;
      }
      if (result.mode === 'not-linked') {
        setNotLinked(result.message);
        setStep('input');
        return;
      }
      onVerified(pendingMobile, {
        providerVerificationId: result.receipt.providerVerificationId,
        verificationStatus: result.receipt.verificationStatus,
      });
    } finally {
      setBusy(false);
    }
  }, [code, onVerified, pendingMobile, sessionId]);

  if (record?.verified) {
    return (
      <section className="verify-card verify-card-done" aria-label="Aadhaar-linked mobile verification">
        <CardHeader icon="shield" title="Aadhaar-Linked Mobile" badge={<span className="status-pill status-registered">VERIFIED</span>} />
        <VerifiedInline label="✓ Aadhaar-linked mobile verified" value={record.mobile ?? ''} note={
          record.providerVerificationId ? `Provider ID ${record.providerVerificationId}` : undefined
        } />
        {onReset && <button className="btn btn-ghost" style={{ marginTop: '1rem' }} onClick={onReset}>Reset Verification</button>}
      </section>
    );
  }

  return (
    <section className="verify-card" aria-label="Aadhaar-linked mobile verification">
      <CardHeader icon="shield" title="Aadhaar-Linked Mobile" />

      {available === false && (
        <div className="status-msg info" role="status">{AADHAAR_UNAVAILABLE_MESSAGE}</div>
      )}
      {available !== false && (
        <p className="verify-card-desc">
          Confirms this mobile number is linked to your Aadhaar identity via
          an authorized KYC provider. An SMS OTP alone proves nothing about
          Aadhaar linkage — only the provider's confirmation counts. No
          Aadhaar number is collected or stored.
        </p>
      )}

      {step === 'input' ? (
        <>
          <div className="form-field">
            <label className="form-label" htmlFor="aadhaar-mobile-input">Registered Mobile</label>
            <div className="verify-mobile-row">
              <span className="verify-mobile-prefix">+91</span>
              <input
                id="aadhaar-mobile-input"
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                maxLength={13}
                className={`form-input${inputError ? ' form-input-error' : ''}`}
                placeholder="9876543210"
                value={mobile}
                onChange={(e) => { setMobile(e.target.value.replace(/[^\d\s-]/g, '').trimStart()); setInputError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void start(); }}
                disabled={available === false}
              />
            </div>
            {inputError && <span className="form-error">{inputError}</span>}
          </div>

          {actionError && <div className="status-msg error" role="alert">{actionError}</div>}
          {notLinked && <div className="status-msg info" role="status">{notLinked}</div>}

          <button
            className="btn btn-primary btn-lg verify-card-btn"
            onClick={() => void start()}
            disabled={busy || available === false}
          >
            {busy ? 'Checking with identity provider…' : 'Verify Aadhaar-linked mobile'}
          </button>
        </>
      ) : (
        <>
          <p className="profile-otp-context">
            Enter the code the identity provider sent to your{' '}
            <strong>registered</strong> mobile ({pendingMobile}).
          </p>

          {sessionExpiresAt !== null && (
            <p className="profile-otp-sent-note">This challenge expires shortly — restart if it lapses.</p>
          )}

          <div className="form-field">
            <label className="form-label" htmlFor="aadhaar-otp-input">Verification Code</label>
            <input
              id="aadhaar-otp-input"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className={`form-input profile-otp-input${codeError ? ' form-input-error' : ''}`}
              placeholder="_ _ _ _ _ _"
              value={code}
              onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setCodeError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void complete(); }}
            />
            {codeError && <span className="form-error">{codeError}</span>}
          </div>

          <div className="profile-otp-actions">
            <button className="btn btn-primary" onClick={() => void complete()} disabled={code.length !== 6 || busy}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
            <button className="btn btn-ghost" onClick={() => { setStep('input'); setCodeError(null); }}>
              Start Over
            </button>
          </div>
        </>
      )}
    </section>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────

function CardHeader({ icon, title, badge }: { icon: 'mail' | 'shield'; title: string; badge?: ReactNode }) {
  return (
    <div className="verify-card-header">
      <h2 className="verify-card-title">
        {icon === 'mail' ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="m22 7-10 6L2 7" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          </svg>
        )}
        {title}
      </h2>
      {badge}
    </div>
  );
}

function VerifiedInline({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="verify-inline-done">
      <span className="verify-inline-check" aria-hidden="true">✓</span>
      <div>
        <span className="profile-verified-title">{label}</span>
        <span className="profile-verified-value">{value}</span>
        {note && <span className="profile-verified-value" style={{ fontSize: '0.72rem' }}>{note}</span>}
      </div>
    </div>
  );
}

function formatWait(seconds: number): string {
  if (seconds >= 90) return `${Math.ceil(seconds / 60)} min`;
  return `${seconds}s`;
}
