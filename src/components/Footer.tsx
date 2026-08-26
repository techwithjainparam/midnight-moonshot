export default function Footer() {
  return (
    <footer className="site-footer" role="contentinfo">
      <div className="site-footer-inner">
        <div className="site-footer-top">
          <div className="site-footer-brand">
            <span className="site-footer-logo">PRIVESTATE</span>
            <p className="site-footer-tagline">
              Privacy-preserving land registry and property verification on Midnight.
            </p>
          </div>
          <div className="site-footer-links">
            <a className="site-footer-link" href="https://midnight.network" target="_blank" rel="noopener noreferrer">
              Midnight Network
            </a>
            <a className="site-footer-link" href="https://docs.midnight.network" target="_blank" rel="noopener noreferrer">
              Documentation
            </a>
            <a className="site-footer-link" href="https://github.com/IntersectMBO/midnight-js" target="_blank" rel="noopener noreferrer">
              Midnight.js
            </a>
          </div>
        </div>

        <div className="site-footer-divider" />

        <div className="site-footer-bottom">
          <p className="site-footer-legal">
            Property records shown are sample data and are not official government records.
            Legal ownership remains governed by the authoritative land registry.
          </p>
          <p className="site-footer-copy">
            Built on Midnight Network with zero-knowledge proofs
          </p>
        </div>
      </div>
    </footer>
  );
}
