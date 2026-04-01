import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useContracts } from "../hooks/useContracts";
import { useWallet } from "../context/WalletContext";

/**
 * Guards publisher sub-pages. Shows a "not registered" message with a link
 * to register if the connected wallet is not a registered publisher.
 */
export function RequirePublisher({ children }: { children: React.ReactNode }) {
  const { address } = useWallet();
  const contracts = useContracts();
  const [state, setState] = useState<"loading" | "ok" | "unregistered" | "no-wallet">("loading");

  useEffect(() => {
    if (!address) { setState("no-wallet"); return; }
    let cancelled = false;
    contracts.publishers.getPublisher(address).then((data: any) => {
      if (cancelled) return;
      const registered = data?.registered === true || data?.[0] === true;
      setState(registered ? "ok" : "unregistered");
    }).catch(() => { if (!cancelled) setState("unregistered"); });
    return () => { cancelled = true; };
  }, [address, contracts]);

  if (state === "no-wallet") {
    return <div style={{ padding: 20, color: "var(--text-muted)" }}>Connect your wallet to access publisher features.</div>;
  }
  if (state === "loading") {
    return <div style={{ padding: 20, color: "var(--text-muted)" }}>Checking registration...</div>;
  }
  if (state === "unregistered") {
    return (
      <div className="nano-fade" style={{ padding: 20 }}>
        <div className="nano-info nano-info--warn" style={{ marginBottom: 12 }}>
          You are not registered as a publisher. Register first to access this page.
        </div>
        <Link to="/publisher/register" className="nano-btn nano-btn-accent" style={{ padding: "8px 16px", fontSize: 13, textDecoration: "none" }}>
          Register as Publisher
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
