import { NavLink, Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import WalletStatus from './WalletStatus';

// Navigation visibility model:
//
// Disconnected/loading → brand + Connect Wallet only.
// USER (connected)     → Register, Registry, My Dashboard, My Properties.
// OFFICER (demo)       → Officer Portal only — officer navigation is
//                        never shown to normal users, and user
//                        navigation is not mixed into the officer role.
export default function Navbar() {
  const { status, isOfficer, wallet } = useAuth();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `navbar-link${isActive ? ' active' : ''}`;

  return (
    <nav className="navbar" role="navigation" aria-label="Main navigation">
      <div className="navbar-inner">
        <Link to="/" className="navbar-brand">
          <span className="navbar-brand-text">PRIVESTATE</span>
        </Link>

        <div className="navbar-links">
          {status === 'connected' && !isOfficer && (
            <>
              <NavLink to="/register" className={linkClass}>
                Register
              </NavLink>
              <NavLink to="/registry" className={linkClass}>
                Registry
              </NavLink>
              <NavLink to="/dashboard" end className={linkClass}>
                My Dashboard
              </NavLink>
              <Link to="/dashboard#my-properties" className="navbar-link">
                My Properties
              </Link>
              <NavLink to="/login" className={linkClass}>
                Account
              </NavLink>
              <NavLink to="/identity-verification" className={linkClass}>
                Verify Identity
              </NavLink>
            </>
          )}
          {status === 'connected' && isOfficer && (
            <NavLink to="/officer" className={linkClass}>
              Officer Portal
            </NavLink>
          )}
        </div>

        <div className="navbar-wallet">
          {status === 'connected' && isOfficer && (
            <span className="role-badge role-badge-officer">OFFICER · DEMO</span>
          )}
          <WalletStatus wallet={wallet} />
        </div>
      </div>
    </nav>
  );
}
