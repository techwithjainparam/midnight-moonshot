// PRIESTATE — Login account-type chooser (PUBLIC).
//
// This page is NOT wallet-gated: it simply asks the visitor which identity they
// are logging in as, so the correct credential flow is selected up front.
//
//   * User / Citizen  → /login/user  (wallet + mandatory multi-factor login)
//   * Officer         → /officer/login (server-backed officer credential)
//
// The officer flow is distinct from the citizen flow and does NOT require a
// wallet connection.

import { Link } from 'react-router-dom';
import ProductBanner from '../components/ProductBanner';
import { useAuth } from '../auth/AuthContext';

export default function LoginPage() {
  const { officerCapabilities } = useAuth();

  return (
    <div className="page profile-page">
      <ProductBanner />
      <div className="page-header">
        <h1 className="page-title">Log In</h1>
        <p className="page-desc" style={{ maxWidth: 680 }}>
          Choose the account type you want to sign in to. Citizen accounts use
          your connected wallet with mandatory multi-factor authentication;
          officer accounts use a separate server-backed credential.
        </p>
      </div>

      <div className="account-card">
        <section className="account-section">
          <h2 className="account-section-title">Citizen / User</h2>
          <p className="account-section-desc">
            Connect your wallet and complete the mandatory multi-factor login
            (Google, SMS, WhatsApp, then your password). New users will be
            routed to registration.
          </p>
          <Link to="/login/user" className="btn btn-primary">
            Citizen User Sign-In
          </Link>
        </section>

        <hr className="account-divider" />

        <section className="account-section">
          <h2 className="account-section-title">Officer</h2>
          <p className="account-section-desc">
            Sign in with your server-backed officer credential (display name +
            password). No wallet connection is required.
            {officerCapabilities && !officerCapabilities.registrationAvailable
              ? ' (Registration is not enabled on this deployment.)'
              : ''}
          </p>
          <Link to="/officer/login" className="btn btn-ghost">
            Officer Sign-In
          </Link>
        </section>

        <div className="account-card-actions">
          <span className="account-card-note">
            New citizen here? <Link to="/register-account">Create an account</Link>
          </span>
        </div>
      </div>
    </div>
  );
}
