import { useState, useEffect } from "react";
import { useContracts } from "./useContracts";
import { useWallet } from "../context/WalletContext";

export interface UserRoles {
  isAdvertiser: boolean;
  isPublisher: boolean;
  isVoter: boolean;
  isAdmin: boolean;
}

/** Checks if the connected wallet has advertiser, publisher, or voter roles. */
export function useRoles(): UserRoles & { loading: boolean } {
  const contracts = useContracts();
  const { address } = useWallet();
  const [roles, setRoles] = useState<UserRoles>({ isAdvertiser: false, isPublisher: false, isVoter: false, isAdmin: false });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address) { setRoles({ isAdvertiser: false, isPublisher: false, isVoter: false }); return; }

    let cancelled = false;
    setLoading(true);

    (async () => {
      const r: UserRoles = { isAdvertiser: false, isPublisher: false, isVoter: false, isAdmin: false };
      try {
        // Check publisher registration
        const pub = await contracts.publishers.getPublisher(address).catch(() => null);
        r.isPublisher = pub?.registered === true || pub?.[0] === true;
      } catch { /* ignore */ }
      try {
        // Check if they have any campaigns (quick check: scan first few IDs)
        const nextId = Number(await contracts.campaigns.nextCampaignId().catch(() => 0));
        for (let i = Math.max(0, nextId - 20); i < nextId && !r.isAdvertiser; i++) {
          try {
            const adv = await contracts.campaigns.getCampaignAdvertiser(BigInt(i));
            if ((adv as string).toLowerCase() === address.toLowerCase()) r.isAdvertiser = true;
          } catch { /* skip */ }
        }
      } catch { /* ignore */ }
      try {
        // Check if they have any active votes (check last few campaigns for votes)
        const nextId = Number(await contracts.campaigns.nextCampaignId().catch(() => 0));
        for (let i = Math.max(0, nextId - 20); i < nextId && !r.isVoter; i++) {
          try {
            const stake = await contracts.governanceV2.voteStake(BigInt(i), address);
            if (BigInt(stake) > 0n) r.isVoter = true;
          } catch { /* skip */ }
        }
      } catch { /* ignore */ }
      try {
        const owner = await contracts.paymentVault.owner().catch(() => null);
        if (owner && (owner as string).toLowerCase() === address.toLowerCase()) r.isAdmin = true;
      } catch { /* ignore */ }
      if (!cancelled) {
        setRoles(r);
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [address, contracts]);

  return { ...roles, loading };
}
