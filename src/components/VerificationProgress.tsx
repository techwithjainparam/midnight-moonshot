export type VerificationStep =
  | 'wallet-required'
  | 'wallet-connecting'
  | 'wallet-connected'
  | 'preparing'
  | 'generating-proof'
  | 'submitting'
  | 'verified'
  | 'error';

interface VerificationProgressProps {
  step: VerificationStep;
  errorMessage?: string | null;
}

const STEPS: Array<{ key: string; label: string }> = [
  { key: 'wallet', label: 'Connect Wallet' },
  { key: 'prepare', label: 'Prepare Verification' },
  { key: 'prove', label: 'Generate ZK Proof' },
  { key: 'submit', label: 'Submit to Midnight' },
  { key: 'result', label: 'Verification Result' },
];

function stepIndex(step: VerificationStep): number {
  switch (step) {
    case 'wallet-required':
    case 'wallet-connecting':
      return 0;
    case 'wallet-connected':
      return 1;
    case 'preparing':
      return 1;
    case 'generating-proof':
      return 2;
    case 'submitting':
      return 3;
    case 'verified':
      return 4;
    case 'error':
      return -1;
  }
}

export default function VerificationProgress({ step, errorMessage }: VerificationProgressProps) {
  const activeIdx = stepIndex(step);

  return (
    <div className="verification-progress" role="status" aria-label="Verification progress">
      <div className="vp-steps">
        {STEPS.map((s, i) => {
          let cls = 'vp-step';
          if (activeIdx >= 0 && i < activeIdx) cls += ' completed';
          if (activeIdx >= 0 && i === activeIdx) cls += ' active';
          if (step === 'error' && i === STEPS.length - 1) cls += ' error';

          return (
            <div key={s.key} className={cls}>
              <div className="vp-step-indicator">
                <div className="vp-step-dot">
                  {activeIdx >= 0 && i < activeIdx && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  )}
                  {activeIdx >= 0 && i === activeIdx && step !== 'error' && (
                    <div className="vp-step-pulse" />
                  )}
                </div>
                {i < STEPS.length - 1 && <div className="vp-step-line" />}
              </div>
              <span className="vp-step-label">{s.label}</span>
            </div>
          );
        })}
      </div>

      {step === 'error' && errorMessage && (
        <div className="vp-error" role="alert">
          {errorMessage}
        </div>
      )}
    </div>
  );
}
