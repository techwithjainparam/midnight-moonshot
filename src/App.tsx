import { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { initGooglePopupLanding } from './auth/google-oauth';
import RequireWallet from './components/guards/RequireWallet';
import RequireProfile from './components/guards/RequireProfile';
import RequireOfficer from './components/guards/RequireOfficer';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import LandingPage from './pages/LandingPage';
import RegistryPage from './pages/RegistryPage';
import RegisterPage from './pages/RegisterPage';
import RegistrationReviewPage from './pages/RegistrationReviewPage';
import PropertyPage from './pages/PropertyPage';
import VerifyPage from './pages/VerifyPage';
import ResultPage from './pages/ResultPage';
import DashboardPage from './pages/DashboardPage';
import ContactVerificationPage from './pages/ContactVerificationPage';
import OfficerPage from './pages/OfficerPage';
import UserRegistrationPage from './pages/UserRegistrationPage';
import LoginPage from './pages/LoginPage';
import UserLoginPage from './pages/UserLoginPage';
import OfficerLoginPage from './pages/OfficerLoginPage';
import OfficerRegistrationPage from './pages/OfficerRegistrationPage';
import IdentityVerificationPage from './pages/IdentityVerificationPage';

// Route visibility model:
//
// PUBLIC    /                      landing + product info
//           /register-account      account registration — NO wallet required,
//                                  NO wallet address is typed or validated.
//                                  After finalize, the citizen CONNECTS their
//                                  real Midnight wallet to bind it to the
//                                  account (wallet association), then enrolls
//                                  biometrics. (Flow: LANDING → REGISTRATION
//                                  → FINALIZE → CONNECT WALLET (associate)
//                                  → biometric enrollment → LOGIN → factors.)
//           /login                 account-type chooser
//           /officer/login,        officer flows — not wallet-gated
//           /officer/register
// WALLET    /login/user            citizen login DOES require a connected wallet
//           /profile/verify        connected wallet → contact profile step
// PROTECTED (wallet + verified     /register, /register/review, /registry,
//           contact profile*)      /property/:id, /verify/:id,
//                                  /verification/:id, /dashboard
// OFFICER   (server credential +         /officer, /officer/login,
//            demo-authorized fallback)    /officer/register — NOT gated by
//                                        wallet or contact profile.
//
// Guards render nothing while authorization state is loading, so no
// protected content ever flashes before wallet state is known.
export default function App() {
  // The Google OAuth popup lands on the app root with `?google=pending` after
  // a server-verified exchange; announce it to the opener from ANY route.
  useEffect(() => {
    initGooglePopupLanding();
  }, []);

  return (
    <AuthProvider>
      <div className="app">
        <Navbar />
        <main className="app-main">
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/login/user" element={<RequireWallet><UserLoginPage /></RequireWallet>} />
            <Route path="/officer/login" element={<OfficerLoginPage />} />
            <Route path="/officer/register" element={<OfficerRegistrationPage />} />
            <Route path="/register-account" element={<UserRegistrationPage />} />
            <Route path="/identity-verification" element={<RequireWallet><IdentityVerificationPage /></RequireWallet>} />
            <Route path="/profile/verify" element={
              <RequireWallet><ContactVerificationPage /></RequireWallet>
            } />
            <Route path="/register" element={
              <RequireWallet><RequireProfile><RegisterPage /></RequireProfile></RequireWallet>
            } />
            <Route path="/register/review" element={
              <RequireWallet><RequireProfile><RegistrationReviewPage /></RequireProfile></RequireWallet>
            } />
            <Route path="/registry" element={
              <RequireWallet><RequireProfile><RegistryPage /></RequireProfile></RequireWallet>
            } />
            <Route path="/property/:id" element={
              <RequireWallet><RequireProfile><PropertyPage /></RequireProfile></RequireWallet>
            } />
            <Route path="/verify/:id" element={
              <RequireWallet><RequireProfile><VerifyPage /></RequireProfile></RequireWallet>
            } />
            <Route path="/verification/:id" element={
              <RequireWallet><RequireProfile><ResultPage /></RequireProfile></RequireWallet>
            } />
            <Route path="/dashboard" element={
              <RequireWallet><RequireProfile><DashboardPage /></RequireProfile></RequireWallet>
            } />
            <Route path="/officer" element={
              <RequireOfficer><OfficerPage /></RequireOfficer>
            } />
            <Route path="*" element={
              <div className="page not-found-page">
                <div className="page-header">
                  <h1 className="page-title">Page Not Found</h1>
                  <p className="page-desc">The requested page does not exist.</p>
                  <a href="/" className="btn btn-primary" style={{ marginTop: '1.5rem' }}>Return Home</a>
                </div>
              </div>
            } />
          </Routes>
        </main>
        <Footer />
      </div>
    </AuthProvider>
  );
}
