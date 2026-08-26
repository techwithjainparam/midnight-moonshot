import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
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

// Route visibility model:
//
// PUBLIC    /                      landing + product info + connect CTA
// WALLET    /profile/verify        connected wallet → contact profile step
// PROTECTED (wallet + verified     /register, /register/review, /registry,
//           contact profile*)      /property/:id, /verify/:id,
//                                  /verification/:id, /dashboard
// OFFICER   (demo-authorized)      /officer — NOT gated by contact profile
//
// * RequireProfile layers the one-time first-time-user contact
//   verification on top of the existing wallet guard. The wallet remains
//   the authorization identity; officers bypass the contact gate so the
//   Officer Portal flow is unchanged.
//
// Guards render nothing while authorization state is loading, so no
// protected content ever flashes before wallet state is known.
export default function App() {
  return (
    <AuthProvider>
      <div className="app">
        <Navbar />
        <main className="app-main">
          <Routes>
            <Route path="/" element={<LandingPage />} />
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
