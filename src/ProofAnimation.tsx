/**
 * ProofAnimation — Visual state for proof generation, success, and failure.
 */

interface ProofAnimationProps {
  status: 'generating' | 'success' | 'error';
  message?: string;
}

export default function ProofAnimation({ status, message }: ProofAnimationProps) {
  if (status === 'generating') {
    return (
      <div className="proof-container">
        <div className="proof-rings">
          <div className="proof-ring" />
          <div className="proof-ring" />
          <div className="proof-ring" />
          <div className="proof-ring" />
          <div className="proof-center">🔐</div>
        </div>
        <div className="proof-text">Generating zero-knowledge proof…</div>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="proof-container">
        <div className="proof-success">
          <div className="proof-success-icon">✓</div>
          <div className="proof-success-text">Proof generated &amp; submitted</div>
          <div className="proof-success-sub">
            Proved without revealing your input
          </div>
          {message && <div className="status-msg success">{message}</div>}
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="proof-container">
        <div className="proof-failure" role="alert">
          <div className="proof-failure-icon" aria-hidden="true">!</div>
          <div className="proof-failure-text">Proof failed</div>
          <div className="proof-failure-sub">
            The zero-knowledge proof was not generated or submitted. No
            eligibility result was recorded on the Midnight ledger.
          </div>
          {message && <div className="status-msg error">{message}</div>}
        </div>
      </div>
    );
  }

  return null;
}
