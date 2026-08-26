/**
 * ProofAnimation — Visual state for proof generation and success.
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

  return null;
}
