import { useEffect, useState } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import WalletStatus from './WalletStatus';

// Navigation visibility model:
//
// Disconnected (public) → brand + Register + Sign In. No wallet-connect
// button anywhere — wallet connection happens ONLY on the Login page.
// USER (connected)      → Register, Registry, My Dashboard, My Properties.
// OFFICER (demo)        → Officer Portal only — officer navigation is
//                         never shown to normal users, and user
//                         navigation is not mixed into the officer role.
export default function Navbar() {
  const { status, isOfficer, officerAuthorized, wallet } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const showOfficerNav = status === 'connected' && isOfficer;
  const officerRoleLabel =
    (officerAuthorized ? 'OFFICER' : 'OFFICER · DEMO');

  // A navigation click changes the route, so the mobile panel must close
  // rather than stay open over the page the user just opened.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname, location.hash]);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `navbar-link${isActive ? ' active' : ''}`;

  return (
    <nav className="navbar" role="navigation" aria-label="Main navigation">
      <div className="navbar-inner">
        <Link to="/" className="navbar-brand">
          <span className="navbar-brand-text">PRIVESTATE</span>
        </Link>

        <button
          type="button"
          className="navbar-toggle"
          aria-expanded={menuOpen}
          aria-controls="navbar-menu"
          aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="navbar-toggle-bar" aria-hidden="true" />
          <span className="navbar-toggle-bar" aria-hidden="true" />
          <span className="navbar-toggle-bar" aria-hidden="true" />
        </button>

        <div id="navbar-menu" className={`navbar-links${menuOpen ? ' open' : ''}`}>
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
              <NavLink to="/login/user" className={linkClass}>
                Account
              </NavLink>
              <NavLink to="/identity-verification" className={linkClass}>
                Verify Identity
              </NavLink>
            </>
          )}
          {showOfficerNav && (
            <NavLink to="/officer" className={linkClass}>
              Officer Portal
            </NavLink>
          )}
          {status !== 'connected' && (
            <>
              <NavLink to="/register-account" className={linkClass}>
                Create Account
              </NavLink>
              <NavLink to="/login" className={linkClass}>
                Sign In
              </NavLink>
            </>
          )}
        </div>

        <div className="navbar-wallet">
          {showOfficerNav && (
            <span className={`role-badge role-badge-officer`}>{officerRoleLabel}</span>
          )}
          {status === 'connected' && <WalletStatus wallet={wallet} />}
        </div>
      </div>
    </nav>
  );
}
