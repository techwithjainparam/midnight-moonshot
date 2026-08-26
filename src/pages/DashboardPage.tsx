import { Link } from 'react-router-dom';
import ProductBanner from '../components/ProductBanner';
import { MOCK_PROPERTIES } from '../data/mock-properties';
import { useAuth } from '../auth/AuthContext';
import { DEMO_USER_PROPERTY_IDS } from '../auth/roles';
import { getContactProfile, type ContactProfile } from '../profile/contact-verification';

function truncAddr(addr: string): string {
  if (addr.length <= 24) return addr;
  return `${addr.slice(0, 14)}...${addr.slice(-8)}`;
}

function myStatusClass(status: string): string {
  switch (status) {
    case 'APPROVED': return 'status-registered';
    case 'PENDING_REVIEW': return 'status-pending';
    case 'SUBMITTED': return 'status-submitted';
    case 'REJECTED': return 'status-rejected';
    default: return 'status-draft';
  }
}

// USER dashboard: own application/property information and public
// registry aggregates only. Officer queue, officer notes, and
// administrative data are NOT shown here — they live exclusively in the
// Officer Portal behind the officer role check.
export default function DashboardPage() {
  const { wallet, address } = useAuth();
  const { walletState, deployments, connect } = wallet;

  // Own contact profile (FEATURE 1) — private to this wallet.
  const contactProfile: ContactProfile | null = address ? getContactProfile(address) : null;

  // Public registry aggregate: finalized public records only.
  const publicCount = MOCK_PROPERTIES.filter((p) => p.registrationStatus === 'APPROVED').length;

  // Own records (demo binding — see src/auth/roles.ts).
  const myProperties = MOCK_PROPERTIES.filter((p) => DEMO_USER_PROPERTY_IDS.includes(p.id));

  return (
    <div className="page dashboard-page">
      <ProductBanner />

      <div className="page-header">
        <h1 className="page-title">My Dashboard</h1>
        <p className="page-desc">
          Your wallet, your properties, and your verification activity.
        </p>
      </div>

      <div className="dashboard-grid">
        <div className="dashboard-card wallet-card-dash">
          <div className="dashboard-card-header">
            <h2 className="dashboard-card-title">Wallet Status</h2>
            {walletState === 'connected' && (
              <span className="dash-badge connected">Connected</span>
            )}
            {walletState !== 'connected' && (
              <span className="dash-badge disconnected">Disconnected</span>
            )}
          </div>

          {walletState === 'connected' && address ? (
            <div className="dashboard-card-body">
              <div className="dash-field">
                <span className="dash-field-label">Address</span>
                <span className="dash-field-value dash-addr" title={address}>{truncAddr(address)}</span>
              </div>
              <div className="dash-field">
                <span className="dash-field-label">Network</span>
                <span className="dash-field-value">Preprod</span>
              </div>
            </div>
          ) : (
            <div className="dashboard-card-body">
              <p className="dash-empty-text">
                Connect your Midnight wallet to interact with the registry and
                generate zero-knowledge proofs.
              </p>
              <button
                className="btn btn-primary"
                onClick={connect}
                disabled={walletState !== 'ready'}
              >
                {walletState === 'ready' ? 'Connect Wallet' : 'Detecting Wallet...'}
              </button>
            </div>
          )}
        </div>

        <div className="dashboard-card" id="contact-profile">
          <div className="dashboard-card-header">
            <h2 className="dashboard-card-title">Contact Profile</h2>
            {contactProfile ? (
              <span className="dash-badge connected">Verified</span>
            ) : (
              <span className="dash-badge disconnected">Not Verified</span>
            )}
          </div>
          <div className="dashboard-card-body">
            {contactProfile ? (
              <>
                <div className="dash-field">
                  <span className="dash-field-label">{contactProfile.contactType === 'email' ? 'Email' : 'Mobile'}</span>
                  <span className="dash-field-value">{contactProfile.contactValue}</span>
                </div>
                <p className="dash-empty-text">
                  Private notification channel for registration updates, officer
                  decisions, and alerts. Never shown in the public registry.
                  (Development OTP provider — codes are not delivered by
                  SMS/email yet.)
                </p>
                <Link to="/profile/verify" className="btn btn-ghost btn-sm" style={{ marginTop: '0.75rem' }}>
                  Change Contact
                </Link>
              </>
            ) : (
              <>
                <p className="dash-empty-text">
                  Verify an email or mobile number to receive registration
                  updates, officer decisions, and important alerts. Your wallet
                  remains your primary identity.
                </p>
                <Link to="/profile/verify" className="btn btn-primary btn-sm" style={{ marginTop: '0.75rem' }}>
                  Verify Contact
                </Link>
              </>
            )}
          </div>
        </div>

        <div className="dashboard-card" id="my-properties">
          <div className="dashboard-card-header">
            <h2 className="dashboard-card-title">My Properties</h2>
          </div>
          <div className="dashboard-card-body">
            {myProperties.length > 0 ? (
              <div className="dash-my-properties">
                {myProperties.map((p) => (
                  <Link key={p.id} to={`/property/${p.id}`} className="dash-my-property">
                    <span className="dash-my-prop-id">{p.propertyId}</span>
                    <span className={`status-pill ${myStatusClass(p.registrationStatus)}`}>
                      {p.registrationStatus.replace('_', ' ')}
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="dash-empty-text">
                No properties registered yet.
              </p>
            )}
            <Link to="/register" className="btn btn-ghost btn-sm" style={{ marginTop: '0.75rem' }}>
              Register New Property
            </Link>
          </div>
        </div>

        <div className="dashboard-card">
          <div className="dashboard-card-header">
            <h2 className="dashboard-card-title">Public Registry</h2>
          </div>
          <div className="dashboard-card-body">
            <div className="dash-stats">
              <div className="dash-stat">
                <span className="dash-stat-value">{publicCount}</span>
                <span className="dash-stat-label">Finalized Public Records</span>
              </div>
            </div>
            <p className="dash-empty-text">
              Applications under review are private to their owners and are
              only visible to authorized officers.
            </p>
          </div>
        </div>

        <div className="dashboard-card">
          <div className="dashboard-card-header">
            <h2 className="dashboard-card-title">Verification Activity</h2>
          </div>
          <div className="dashboard-card-body">
            {deployments.length > 0 ? (
              <div className="dash-deployments">
                {deployments.map((d, i) => (
                  <div key={i} className="dash-deployment">
                    <span className={`dash-dep-status ${d.status}`}>
                      {d.status === 'deployed' ? 'Verified' :
                       d.status === 'in-progress' ? 'In Progress' : 'Failed'}
                    </span>
                    <span className="dash-dep-detail">
                      {d.status === 'deployed' ? `Contract: ${d.api.deployedContractAddress.slice(0, 16)}...` :
                       d.status === 'failed' ? 'Contract deployment failed' : 'Deploying contract...'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="dash-empty">
                <div className="dash-empty-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                  </svg>
                </div>
                <p className="dash-empty-text">
                  No verification activity yet. Visit the registry to verify a property.
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="dashboard-card dashboard-card-actions">
          <div className="dashboard-card-header">
            <h2 className="dashboard-card-title">Quick Actions</h2>
          </div>
          <div className="dashboard-card-body">
            <div className="dash-actions">
              <Link to="/registry" className="btn btn-primary dash-action-btn">
                Browse Registry
              </Link>
              {myProperties.length > 0 && (
                <Link to={`/property/${myProperties[0].id}`} className="btn btn-ghost dash-action-btn">
                  View My Property
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
