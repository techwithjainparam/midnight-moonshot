import { useState, useCallback, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getPropertyById } from '../data/mock-properties';
import { canUserViewRecord } from '../data/visibility';
import { saveOnChainEligibility } from '../data/on-chain-result';
import ProductBanner from '../components/ProductBanner';
import VerificationProgress, { type VerificationStep } from '../components/VerificationProgress';
import ProofAnimation from '../ProofAnimation';
import { useAuth } from '../auth/AuthContext';
import { NETWORK_ID, describeError } from '../hooks/useWallet';

export default function VerifyPage() {
  const { id } = useParams<{ id: string }>();
  const property = id ? getPropertyById(id) : undefined;
  // Shared auth wallet instance — never a second detection/connect instance.
  const { wallet } = useAuth();

  const [verStep, setVerStep] = useState<VerificationStep>('wallet-required');
  const [proofError, setProofError] = useState<string | null>(null);
  const [verificationResult, setVerificationResult] = useState<boolean | null>(null);

  useEffect(() => {
    if (wallet.walletState === 'connected') {
      setVerStep('wallet-connected');
    } else if (wallet.walletState === 'connecting') {
      setVerStep('wallet-connecting');
    } else {
      setVerStep('wallet-required');
    }
  }, [wallet.walletState]);

  const runVerification = useCallback(async () => {
    if (!property || !wallet.wallet || !wallet.manager) return;
    setProofError(null);
    setVerificationResult(null);

    setVerStep('preparing');
    try {
      const threshold = property.eligibilityThreshold;
      const deployment$ = wallet.manager.resolve(undefined, threshold);

      await new Promise<void>((resolve, reject) => {
        const sub = deployment$.subscribe({
          next: (d) => {
            if (d.status === 'deployed') {
              sub.unsubscribe();
              resolve();
            }
            if (d.status === 'failed') {
              sub.unsubscribe();
              reject(d.error);
            }
          },
          error: (err) => {
            sub.unsubscribe();
            reject(err);
          },
        });
      });

      setVerStep('generating-proof');

      const deployment = wallet.deployments.find(
        (d) => d.status === 'deployed' && d.api.deployedContractAddress
      );

      if (deployment && deployment.status === 'deployed') {
        // The circuit call resolves with the ON-CHAIN eligibilityResult from
        // the contract's public ledger state. The private property value
        // never leaves the witness, and the displayed result is the one the
        // contract computed — not a local recomputation.
        const onChainResult = await deployment.api.checkEligibility(
          property.propertyValue,
          () => setVerStep('submitting'),
        );
        saveOnChainEligibility({
          propertyId: property.propertyId,
          result: onChainResult,
          finalizedAt: new Date().toISOString(),
        });
        setVerificationResult(onChainResult);
        setVerStep('verified');
      } else {
        throw new Error('Contract deployment did not complete successfully.');
      }
    } catch (e: unknown) {
      setVerStep('error');
      setProofError(describeError(e));
    }
  }, [property, wallet]);

  if (!property || !canUserViewRecord(property)) {
    return (
      <div className="page">
        <ProductBanner />
        <div className="page-header">
          <h1 className="page-title">Property Not Available</h1>
          <p className="page-desc">This property does not exist or is not available for verification.</p>
          <Link to="/registry" className="btn btn-primary" style={{ marginTop: '1.5rem' }}>Back to Registry</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page verify-page">
      <ProductBanner />

      <div className="page-header">
        <Link to={`/property/${property.id}`} className="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
          Back to Property Record
        </Link>
      </div>

      <div className="verify-layout">
        <div className="verify-main">
          <h1 className="page-title">Verify Property Eligibility</h1>
          <p className="page-desc">
            Prove that the property meets the eligibility threshold using
            a zero-knowledge proof. The actual property value remains private.
          </p>

          <VerificationProgress step={verStep} errorMessage={proofError} />

          <div className="verify-card">
            <div className="verify-card-header">
              <h2 className="verify-card-title">Verification Requirement</h2>
            </div>

            <div className="verify-requirement">
              <div className="verify-req-row">
                <span className="verify-req-label">Condition</span>
                <span className="verify-req-expression">
                  Property Value &ge; Eligibility Threshold
                </span>
              </div>
              <div className="verify-req-row">
                <span className="verify-req-label">Actual Property Value</span>
                <span className="verify-req-value private">
                  PRIVATE
                </span>
              </div>
              <div className="verify-req-row">
                <span className="verify-req-label">Eligibility Threshold</span>
                <span className="verify-req-value">
                  <span className="public-badge">PUBLIC</span>{' '}
                  {Number(property.eligibilityThreshold).toLocaleString()}
                </span>
              </div>
              <div className="verify-req-row">
                <span className="verify-req-label">Disclosure After Proof</span>
                <span className="verify-req-value">
                  <span className="proved-badge">PROVED</span>{' '}
                  <span className="public-badge">PUBLIC</span> Boolean result only
                </span>
              </div>
            </div>

            <div className="verify-privacy-note">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              <p>
                The property value is used privately to prove eligibility
                without unnecessarily revealing the underlying value.
              </p>
            </div>
          </div>

          {verStep === 'generating-proof' && (
            <div className="verify-proof-section">
              <ProofAnimation status="generating" />
            </div>
          )}

          {verStep === 'verified' && verificationResult !== null && (
            <div className="verify-proof-section">
              <ProofAnimation
                status="success"
                message={verificationResult
                  ? 'Eligibility condition satisfied.'
                  : 'Property value does not meet the threshold.'}
              />
            </div>
          )}

          {verStep === 'error' && (
            <div className="verify-proof-section">
              <ProofAnimation status="error" message={proofError ?? undefined} />
            </div>
          )}

          {wallet.walletState === 'connected' && verStep === 'wallet-connected' && (
            <div className="verify-actions">
              <button className="btn btn-primary btn-lg" onClick={runVerification}>
                Begin Verification
              </button>
            </div>
          )}

          {(verStep === 'preparing' || verStep === 'generating-proof' || verStep === 'submitting') && (
            <div className="verify-actions">
              <button className="btn btn-primary btn-lg" disabled>
                {verStep === 'preparing' && 'Preparing...'}
                {verStep === 'generating-proof' && 'Generating Proof...'}
                {verStep === 'submitting' && 'Submitting...'}
              </button>
            </div>
          )}

          {verStep === 'verified' && (
            <div className="verify-actions">
              <Link to={`/verification/${property.id}`} className="btn btn-primary btn-lg">
                View Verification Result
              </Link>
            </div>
          )}

          {verStep === 'error' && wallet.walletState === 'connected' && (
            <div className="verify-actions">
              <button className="btn btn-primary btn-lg" onClick={runVerification}>
                Try Verification Again
              </button>
            </div>
          )}
        </div>

        <div className="verify-sidebar">
          <div className="verify-property-info">
            <h3 className="verify-sidebar-title">Property</h3>
            <div className="verify-sidebar-fields">
              <div className="verify-sidebar-field">
                <span className="verify-sidebar-label">Property ID</span>
                <span className="verify-sidebar-value">{property.propertyId}</span>
              </div>
              <div className="verify-sidebar-field">
                <span className="verify-sidebar-label">Type</span>
                <span className="verify-sidebar-value">{property.propertyType}</span>
              </div>
              <div className="verify-sidebar-field">
                <span className="verify-sidebar-label">Location</span>
                <span className="verify-sidebar-value">{property.village}, {property.district}</span>
              </div>
              <div className="verify-sidebar-field">
                <span className="verify-sidebar-label">Area</span>
                <span className="verify-sidebar-value">{property.landArea}</span>
              </div>
            </div>
          </div>

          {wallet.walletState === 'connected' && (
            <div className="verify-wallet-info">
              <h3 className="verify-sidebar-title">Wallet</h3>
              <div className="verify-sidebar-field">
                <span className="verify-sidebar-label">Network</span>
                <span className="verify-sidebar-value">{NETWORK_ID}</span>
              </div>
              {wallet.address && (
                <div className="verify-sidebar-field">
                  <span className="verify-sidebar-label">Address</span>
                  <span className="verify-sidebar-value verify-sidebar-addr">{wallet.address.slice(0, 18)}...</span>
                </div>
              )}
            </div>
          )}

          {wallet.walletState !== 'connected' && (
            <div className="verify-connect-prompt">
              <h3 className="verify-sidebar-title">Connect Wallet</h3>
              <p className="verify-connect-desc">
                A Midnight-compatible wallet is required to generate
                zero-knowledge proofs and submit verification.
              </p>
              <button className="btn btn-primary" onClick={wallet.connect} disabled={wallet.walletState !== 'ready'}>
                {wallet.walletState === 'ready' ? 'Connect Wallet' : 'Detecting...'}
              </button>
              {wallet.error && (
                <div className="status-msg error" style={{ marginTop: '0.75rem' }}>{wallet.error}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
