import { Link } from 'react-router-dom';
import ProductBanner from '../components/ProductBanner';
import PrivacyVisual from '../PrivacyVisual';
import { useAuth } from '../auth/AuthContext';

export default function LandingPage() {
  const { status, wallet } = useAuth();

  return (
    <div className="page landing-page">
      <ProductBanner />

      <section className="landing-hero">
        <div className="landing-hero-badge">
          <span className="landing-hero-badge-dot" />
          Midnight Network -- Zero-Knowledge
        </div>
        <h1 className="landing-hero-title">PRIVESTATE</h1>
        <p className="landing-hero-subtitle">
          Privacy-Preserving Digital Land &amp; Property Registration
        </p>
        <p className="landing-hero-desc">
          Register property records, submit them for authorized review, and use
          privacy-preserving verification when sensitive eligibility information
          needs to be proven.
        </p>

        <PrivacyVisual />

        <div className="landing-hero-actions">
          {status === 'connected' ? (
            <>
              <Link to="/register" className="btn btn-primary btn-lg">
                Register Property
              </Link>
              <Link to="/registry" className="btn btn-ghost btn-lg">
                View Registry
              </Link>
            </>
          ) : (
            <>
              <button
                className="btn btn-primary btn-lg"
                onClick={wallet.connect}
                disabled={wallet.walletState !== 'ready'}
              >
                {wallet.walletState === 'ready' ? 'Connect Wallet' : 'Detecting Wallet...'}
              </button>
              <p className="landing-connect-note">
                Connect your wallet to access PRIESTATE.
              </p>
            </>
          )}
        </div>
      </section>

      <section className="landing-flow" id="how-it-works">
        <div className="landing-flow-inner">
          <h2 className="landing-section-heading">How It Works</h2>
          <p className="landing-section-desc">
            PrivEstate combines digital property registration with authorized
            officer review and privacy-preserving ZK verification on Midnight.
          </p>

          <div className="flow-steps">
            <div className="flow-step">
              <div className="flow-step-num">1</div>
              <div className="flow-step-content">
                <h3 className="flow-step-title">Register</h3>
                <p className="flow-step-desc">
                  Property owner or builder connects a wallet and submits
                  property and registration details.
                </p>
              </div>
            </div>

            <div className="flow-connector" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M19 12l-7 7-7-7"/>
              </svg>
            </div>

            <div className="flow-step">
              <div className="flow-step-num">2</div>
              <div className="flow-step-content">
                <h3 className="flow-step-title">Submit</h3>
                <p className="flow-step-desc">
                  The application is submitted for review. Private property
                  value data is kept confidential.
                </p>
              </div>
            </div>

            <div className="flow-connector" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M19 12l-7 7-7-7"/>
              </svg>
            </div>

            <div className="flow-step">
              <div className="flow-step-num">3</div>
              <div className="flow-step-content">
                <h3 className="flow-step-title">Authorized Review</h3>
                <p className="flow-step-desc">
                  An authorized registry officer reviews the application,
                  documents, and verification data.
                </p>
              </div>
            </div>

            <div className="flow-connector" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M19 12l-7 7-7-7"/>
              </svg>
            </div>

            <div className="flow-step">
              <div className="flow-step-num">4</div>
              <div className="flow-step-content">
                <h3 className="flow-step-title">ZK Privacy Verification</h3>
                <p className="flow-step-desc">
                  Where applicable, a zero-knowledge proof verifies eligibility
                  conditions without revealing sensitive property data.
                </p>
              </div>
            </div>

            <div className="flow-connector" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M19 12l-7 7-7-7"/>
              </svg>
            </div>

            <div className="flow-step">
              <div className="flow-step-num">5</div>
              <div className="flow-step-content">
                <h3 className="flow-step-title">Approved</h3>
                <p className="flow-step-desc">
                  Upon approval, the registration is confirmed. Official legal
                  ownership remains governed by the government land registry.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-benefits">
        <div className="landing-benefits-inner">
          <h2 className="landing-section-heading">Why PrivEstate</h2>

          <div className="benefits-grid">
            <div className="benefit-card">
              <div className="benefit-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
              </div>
              <h3 className="benefit-title">Privacy-First Registration</h3>
              <p className="benefit-desc">
                Sensitive property values remain private. Only verification
                results are recorded, never the underlying data.
              </p>
            </div>

            <div className="benefit-card">
              <div className="benefit-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
              </div>
              <h3 className="benefit-title">Authorized Review</h3>
              <p className="benefit-desc">
                Every registration goes through an authorized officer review
                process before approval.
              </p>
            </div>

            <div className="benefit-card">
              <div className="benefit-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </div>
              <h3 className="benefit-title">ZK Cryptographic Proof</h3>
              <p className="benefit-desc">
                Zero-knowledge proofs provide mathematical certainty that
                eligibility conditions are met, without revealing private data.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-disclaimer">
        <div className="landing-disclaimer-inner">
          <p>
            Records shown in this environment are sample data and do not
            represent official government records. PrivEstate does not legally
            establish property ownership — legal ownership remains governed by
            the authoritative land registry.
          </p>
        </div>
      </section>
    </div>
  );
}
