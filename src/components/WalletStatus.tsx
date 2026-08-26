import type { UseWalletReturn } from '../hooks/useWallet';

function truncAddr(addr: string): string {
  if (addr.length <= 24) return addr;
  return `${addr.slice(0, 14)}...${addr.slice(-8)}`;
}

interface WalletStatusProps {
  wallet: UseWalletReturn;
}

export default function WalletStatus({ wallet }: WalletStatusProps) {
  const { walletState, address, connect, disconnect, error } = wallet;

  if (walletState === 'connected' && address) {
    return (
      <div className="wallet-status">
        <span className="wallet-dot connected" />
        <span className="wallet-address" title={address}>{truncAddr(address)}</span>
        <button className="btn btn-ghost btn-sm" onClick={disconnect} aria-label="Disconnect wallet">
          Disconnect
        </button>
      </div>
    );
  }

  if (walletState === 'detecting' || walletState === 'connecting') {
    return (
      <button className="btn btn-primary btn-sm" disabled>
        {walletState === 'detecting' ? 'Detecting' : 'Connecting'}
        <span className="connecting-dots"><span /><span /><span /></span>
      </button>
    );
  }

  if (walletState === 'no-wallet') {
    return (
      <div className="wallet-status-missing">
        <button className="btn btn-primary btn-sm" disabled>
          Wallet Required
        </button>
      </div>
    );
  }

  if (walletState === 'incompatible') {
    return (
      <button className="btn btn-primary btn-sm" disabled>
        Incompatible
      </button>
    );
  }

  return (
    <div className="wallet-status-actions">
      <button className="btn btn-primary btn-sm" onClick={connect}>
        Connect Wallet
      </button>
      {error && (
        <div className="wallet-error-tooltip" role="alert">{error}</div>
      )}
    </div>
  );
}
