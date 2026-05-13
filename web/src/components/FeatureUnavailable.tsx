// Shown when a feature requires a contract that isn't deployed / configured
// on the current network. Lets the user paste the address into Settings.

import { Link } from "react-router-dom";

interface Props {
  /** Human label for the feature (e.g. "WDATUM Wrapper"). */
  feature: string;
  /** Settings key the user needs to populate (e.g. "wrapper"). */
  addressKey?: string;
  /** Optional extra context — e.g. "Wrapper not yet deployed on Paseo testnet." */
  reason?: string;
}

export function FeatureUnavailable({ feature, addressKey, reason }: Props) {
  return (
    <div className="nano-info" style={{ maxWidth: 560, marginTop: 20 }}>
      <div style={{ color: "var(--text-strong)", fontWeight: 600, marginBottom: 4 }}>
        {feature} unavailable on this network
      </div>
      <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
        {reason ?? "The contract address isn't configured for the current deployment."}
        {addressKey && (
          <>
            {" "}
            <Link to="/settings" style={{ color: "var(--accent)" }}>
              Set <code>{addressKey}</code> in Settings
            </Link>
            {" "}once the contract is deployed.
          </>
        )}
      </div>
    </div>
  );
}
