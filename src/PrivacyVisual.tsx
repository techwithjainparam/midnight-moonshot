/**
 * PrivacyVisual — CSS 3D centerpiece showing the zero-knowledge flow:
 * PRIVATE INPUT → ZERO-KNOWLEDGE PROOF → VERIFIED RESULT
 */

import { useMemo } from 'react';

interface Particle {
  id: number;
  left: string;
  delay: string;
  duration: string;
  drift: string;
  size: string;
  opacity: number;
}

export default function PrivacyVisual() {
  const particles = useMemo<Particle[]>(() => {
    return Array.from({ length: 18 }, (_, i) => ({
      id: i,
      left: `${5 + Math.random() * 90}%`,
      delay: `${Math.random() * 4}s`,
      duration: `${3 + Math.random() * 3}s`,
      drift: `${-30 + Math.random() * 60}px`,
      size: `${2 + Math.random() * 2}px`,
      opacity: 0.3 + Math.random() * 0.4,
    }));
  }, []);

  return (
    <div className="privacy-visual-container">
      <div className="privacy-visual">
        {/* Background particles */}
        <div className="pv-particles">
          {particles.map((p) => (
            <div
              key={p.id}
              className="pv-particle"
              style={{
                left: p.left,
                bottom: '10%',
                width: p.size,
                height: p.size,
                animationDelay: p.delay,
                animationDuration: p.duration,
                ['--drift' as string]: p.drift,
                opacity: p.opacity,
              }}
            />
          ))}
        </div>

        {/* Main flow */}
        <div className="pv-stage">
          {/* PRIVATE INPUT */}
          <div className="pv-node">
            <div
              className="pv-icon-ring"
              style={{ '--ring-color': 'var(--color-private)' } as React.CSSProperties}
            >
              <div className="pv-icon">🔒</div>
            </div>
            <span className="pv-label">Private Input</span>
          </div>

          <div className="pv-arrow" />

          {/* ZERO-KNOWLEDGE PROOF */}
          <div className="pv-node">
            <div
              className="pv-icon-ring"
              style={{ '--ring-color': 'var(--color-accent)' } as React.CSSProperties}
            >
              <div className="pv-icon">⚡</div>
            </div>
            <span className="pv-label">Zero-Knowledge Proof</span>
          </div>

          <div className="pv-arrow" />

          {/* VERIFIED RESULT */}
          <div className="pv-node">
            <div
              className="pv-icon-ring"
              style={{ '--ring-color': 'var(--color-success)' } as React.CSSProperties}
            >
              <div className="pv-icon">✓</div>
            </div>
            <span className="pv-label">Verified Result</span>
          </div>
        </div>
      </div>
    </div>
  );
}
