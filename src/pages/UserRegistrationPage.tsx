import { useState, useCallback, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ProductBanner from '../components/ProductBanner';
import { useAuth } from '../auth/AuthContext';
import {
  validateRegistrationForm,
  normalizeIndianMobile,
  maskAadhaar,
  type AccountCapabilities,
  type RegistrationFieldErrors,
} from '../auth/account-types';
import {
  registerAccount,
  fetchAccountCapabilities,
} from '../auth/account-api';
import { saveAccount, getAccount } from '../auth/account-store';

// FEATURE 3 — Secure user registration (`/register-account`).
//
// Creates a Level 3 PRIESTATE account bound to the connected Midnight
// wallet, collecting profile data, a password, and the five login factors.
// Passwords are hashed (salted scrypt) and raw PII (Aadhaar, address, DOB,
// mobile) is encrypted at rest — all on the verification server. This client
// only ever stores masked fragments and never a password, OTP, or raw PII.
//
// The multi-factor channels (SMS/WhatsApp/Google) are REAL providers gated by
// server configuration via `fetchAccountCapabilities`. When a factor is not
// configured the UI shows it as unavailable and registration cannot be
// completed — no fake auth, no hard-coded credentials.

export default function UserRegistrationPage() {
  const { address } = useAuth();
  const navigate = useNavigate();

  const [caps, setCaps] = useState<AccountCapabilities | null>(null);
  const [capsLoaded, setCapsLoaded] = useState(false);

  const [fullName, setFullName] = useState('');
  const [aadhaarNumber, setAadhaarNumber] = useState('');
  const [aadhaarMasked, setAadhaarMasked] = useState(false);
  const [addressOnAadhaar, setAddressOnAadhaar] = useState('');
  const [pincode, setPincode] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [passportPhoto, setPassportPhoto] = useState<File | null>(null);

  const [errors, setErrors] = useState<RegistrationFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ accountId: string; maskedMobile: string; maskedAadhaar: string } | null>(null);

  // Existing account for this wallet → direct them to login.
  useEffect(() => {
    if (address && getAccount(address)) {
      navigate('/login', { replace: true });
    }
  }, [address, navigate]);

  // Discover which server-side factor channels are configured (honest state).
  useEffect(() => {
    let cancelled = false;
    fetchAccountCapabilities().then((r) => {
      if (cancelled) return;
      setCaps(r.ok ? r.data : { smsConfigured: false, whatsappConfigured: false, googleConfigured: false });
      setCapsLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  if (!address) {
    return (
      <div className="page profile-page">
        <ProductBanner />
        <div className="auth-gate">
          <h1 className="auth-gate-title">Connect your wallet to continue.</h1>
          <p className="auth-gate-desc">A connected Midnight wallet is required to create a PRIESTATE account.</p>
          <Link to="/" className="btn btn-primary btn-lg">Return Home</Link>
        </div>
      </div>
    );
  }

  const allFactorsConfigured = caps ? (caps.smsConfigured && caps.whatsappConfigured && caps.googleConfigured) : false;

  const handleAadhaarBlur = () => {
    if (aadhaarNumber.replace(/\s/g, '').length === 12) setAadhaarMasked(true);
  };

  const handleRegister = useCallback(async () => {
    setFormError(null);
    const formErrors = validateRegistrationForm({
      fullName,
      aadhaarNumber: aadhaarNumber.replace(/\s/g, ''),
      pincode,
      dateOfBirth,
      mobile,
      password,
      passwordConfirm,
    });
    setErrors(formErrors);
    if (Object.keys(formErrors).length > 0) return;
    if (!caps || !caps.smsConfigured || !caps.whatsappConfigured || !caps.googleConfigured) {
      setFormError('Registration requires live SMS, WhatsApp, and Google login factors, which are not all configured on the verification server in this demo. Configure the provider gateways to enable account creation.');
      return;
    }
    const mobileE164 = normalizeIndianMobile(mobile);
    if (!mobileE164) {
      setErrors({ mobile: 'Enter a valid Indian mobile number.' });
      return;
    }
    const result = await registerAccount({
      walletAddress: address,
      fullName: fullName.trim(),
      aadhaarNumber: aadhaarNumber.replace(/\s/g, ''),
      addressOnAadhaar: addressOnAadhaar.trim() || undefined,
      pincode: pincode.trim() || undefined,
      dateOfBirth,
      mobile: mobileE164,
      password,
      passwordConfirm,
    });
    if (!result.ok) {
      setFormError(registerErrorMessage(result.reason, result.message));
      return;
    }
    const view = result.data.account;
    saveAccount(view);
    setSuccess({
      accountId: view.accountId,
      maskedMobile: view.maskedMobile,
      maskedAadhaar: view.maskedAadhaar,
    });
  }, [address, aadhaarNumber, addressOnAadhaar, caps, dateOfBirth, fullName, mobile, password, passwordConfirm, pincode]);

  if (success) {
    return (
      <div className="page profile-page">
        <ProductBanner />
        <div className="page-header">
          <h1 className="page-title">Account Created</h1>
          <p className="page-desc">Your PRIESTATE account is registered and bound to your wallet.</p>
        </div>
        <div className="profile-card">
          <div className="profile-steps" aria-label="Status">
            <span className="profile-step done active">✓ Registered</span>
          </div>
          <p className="profile-done-note">
            Complete the multi-factor steps below to finish setting up your
            account, then verify your identity to fully log in. Your mobile and
            Aadhaar are stored encrypted on the server and shown here only
            masked.
          </p>
          <div className="profile-done-actions">
            <button className="btn btn-primary btn-lg" onClick={() => navigate('/login')}>Continue to Login</button>
            <button className="btn btn-ghost" onClick={() => navigate('/dashboard')}>Dashboard</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page profile-page">
      <ProductBanner />
      <div className="page-header">
        <h1 className="page-title">Create Your PRIESTATE Account</h1>
        <p className="page-desc" style={{ maxWidth: 680 }}>
          Level 3 registration binds a secure account to your connected wallet.
          Your password is stored only as a salted hash and your Aadhaar,
          address, date of birth, and mobile number are encrypted at rest on
          the verification server — they are never stored on the ledger and
          never kept in plaintext on this device.
        </p>
      </div>

      <div className="account-card">
        <section className="account-section">
          <h2 className="account-section-title">Identity & Contact</h2>

          <div className="form-field">
            <label className="form-label" htmlFor="reg-fullname">Full Name (as on Aadhaar)</label>
            <input
              id="reg-fullname"
              type="text"
              autoComplete="name"
              className={`form-input${errors.fullName ? ' form-input-error' : ''}`}
              value={fullName}
              onChange={(e) => { setFullName(e.target.value); setErrors((prev) => ({ ...prev, fullName: undefined })); }}
            />
            {errors.fullName && <span className="form-error">{errors.fullName}</span>}
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="reg-aadhaar">Aadhaar Number</label>
            <input
              id="reg-aadhaar"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              className={`form-input${errors.aadhaarNumber ? ' form-input-error' : ''}`}
              placeholder="•••• •••• 4321"
              value={aadhaarMasked && aadhaarNumber.length === 12 ? maskAadhaar(aadhaarNumber) : aadhaarNumber}
              onChange={(e) => { setAadhaarNumber(e.target.value.replace(/\D/g, '').slice(0, 12)); setAadhaarMasked(false); setErrors((prev) => ({ ...prev, aadhaarNumber: undefined })); }}
              onBlur={handleAadhaarBlur}
            />
            {errors.aadhaarNumber ? (
              <span className="form-error">{errors.aadhaarNumber}</span>
            ) : (
              <span className="form-hint">Masked after entry; encrypted at rest server-side. Never stored on-chain.</span>
            )}
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="reg-address">Address (as on Aadhaar)</label>
            <input
              id="reg-address"
              type="text"
              className="form-input"
              value={addressOnAadhaar}
              maxLength={200}
              onChange={(e) => setAddressOnAadhaar(e.target.value)}
            />
            <span className="form-hint">Encrypted at rest. Never displayed publicly or stored on-chain.</span>
          </div>

          <div className="form-row">
            <div className="form-field">
              <label className="form-label" htmlFor="reg-pincode">Pincode</label>
              <input
                id="reg-pincode"
                type="text"
                inputMode="numeric"
                className={`form-input${errors.pincode ? ' form-input-error' : ''}`}
                value={pincode}
                maxLength={6}
                onChange={(e) => { setPincode(e.target.value.replace(/\D/g, '').slice(0, 6)); setErrors((prev) => ({ ...prev, pincode: undefined })); }}
              />
              {errors.pincode && <span className="form-error">{errors.pincode}</span>}
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="reg-dob">Date of Birth</label>
              <input
                id="reg-dob"
                type="date"
                className={`form-input${errors.dateOfBirth ? ' form-input-error' : ''}`}
                value={dateOfBirth}
                onChange={(e) => { setDateOfBirth(e.target.value); setErrors((prev) => ({ ...prev, dateOfBirth: undefined })); }}
              />
              {errors.dateOfBirth && <span className="form-error">{errors.dateOfBirth}</span>}
            </div>
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="reg-mobile">Mobile Number</label>
            <div className="verify-mobile-row">
              <span className="verify-mobile-prefix">+91</span>
              <input
                id="reg-mobile"
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                maxLength={10}
                className={`form-input${errors.mobile ? ' form-input-error' : ''}`}
                placeholder="9876543210"
                value={mobile}
                onChange={(e) => { setMobile(e.target.value.replace(/\D/g, '').slice(0, 10)); setErrors((prev) => ({ ...prev, mobile: undefined })); }}
              />
            </div>
            {errors.mobile && <span className="form-error">{errors.mobile}</span>}
            <span className="form-hint">Used for SMS and WhatsApp OTP at login. Encrypted at rest; shown only masked.</span>
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="reg-photo">Passport Photo</label>
            <input
              id="reg-photo"
              type="file"
              accept="image/*"
              className="form-input"
              onChange={(e) => { const f = e.target.files?.[0] ?? null; setPassportPhoto(f); }}
            />
            <span className="form-hint">
              {passportPhoto
                ? `Selected: ${passportPhoto.name} (${(passportPhoto.size / 1024).toFixed(1)} KB). Used only for DEMO identity verification — never stored on-chain or retained as raw data.`
                : 'Upload a passport-style photo for the DEMO identity verification step. It is used only locally for the clearly-labelled demo face match.'}
            </span>
          </div>
        </section>

        <section className="account-section">
          <h2 className="account-section-title">Password</h2>
          <div className="form-row">
            <div className="form-field">
              <label className="form-label" htmlFor="reg-password">Password</label>
              <input
                id="reg-password"
                type="password"
                autoComplete="new-password"
                className={`form-input${errors.password ? ' form-input-error' : ''}`}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setErrors((prev) => ({ ...prev, password: undefined })); }}
              />
              {errors.password && <span className="form-error">{errors.password}</span>}
              <span className="form-hint">Stored only as a salted scrypt hash — never plaintext, never on-chain.</span>
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="reg-password-confirm">Confirm Password</label>
              <input
                id="reg-password-confirm"
                type="password"
                autoComplete="new-password"
                className={`form-input${errors.passwordConfirm ? ' form-input-error' : ''}`}
                value={passwordConfirm}
                onChange={(e) => { setPasswordConfirm(e.target.value); setErrors((prev) => ({ ...prev, passwordConfirm: undefined })); }}
              />
              {errors.passwordConfirm && <span className="form-error">{errors.passwordConfirm}</span>}
            </div>
          </div>
        </section>

        <section className="account-section">
          <h2 className="account-section-title">Login Factors</h2>
          <p className="account-section-desc">
            PRIESTATE login requires <strong>all</strong> of the following
            factors — they are not alternatives. Each is gated by a real
            provider configured on the verification server.
          </p>
          <FactorRow
            name="SMS OTP"
            configured={capsLoaded ? Boolean(caps?.smsConfigured) : null}
            detail="A one-time code sent by SMS to your registered mobile."
          />
          <FactorRow
            name="WhatsApp OTP"
            configured={capsLoaded ? Boolean(caps?.whatsappConfigured) : null}
            detail="A one-time code delivered over WhatsApp."
          />
          <FactorRow
            name="Google"
            configured={capsLoaded ? Boolean(caps?.googleConfigured) : null}
            detail="Sign in with Google (OAuth)."
          />
          {capsLoaded && !allFactorsConfigured && (
            <div className="status-msg info" role="status">
              Some login factors are not configured on the verification server
              in this demo. Until all three delivery channels are live,
              account creation and login cannot complete. No fake login is
              used.
            </div>
          )}
        </section>

        {formError && <div className="status-msg error" role="alert">{formError}</div>}

        <div className="account-card-actions">
          <button
            className="btn btn-primary btn-lg"
            onClick={() => void handleRegister()}
            disabled={!capsLoaded}
          >
            Create Account
          </button>
          <span className="account-card-note">
            Already have an account? <Link to="/login">Log in</Link>
          </span>
        </div>
      </div>
    </div>
  );
}

function FactorRow({ name, configured, detail }: { name: string; configured: boolean | null; detail: string }) {
  const state = configured === null ? 'Checking…' : configured ? 'Configured' : 'Unavailable';
  return (
    <div className={`account-factor ${configured ? 'account-factor-ok' : ''}`}>
      <div>
        <span className="account-factor-name">{name}</span>
        <span className="account-factor-detail">{detail}</span>
      </div>
      <span className={`status-pill ${configured ? 'status-registered' : 'status-marked-for-review'}`}>{state}</span>
    </div>
  );
}

function registerErrorMessage(reason: string, message?: string): string {
  switch (reason) {
    case 'already-registered':
      return 'This wallet already has an account. Please log in instead.';
    case 'invalid-input':
      return 'Some of the details you entered are invalid. Check the highlighted fields.';
    case 'unavailable':
      return message ?? 'Account creation is unavailable because the login factor providers are not fully configured.';
    case 'network-error':
      return message ?? 'Could not reach the verification server. Try again.';
    default:
      return message ?? 'Registration could not be completed. Try again.';
  }
}
