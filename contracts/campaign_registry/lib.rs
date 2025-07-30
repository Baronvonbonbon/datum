#![cfg_attr(not(feature = "std"), no_std)]

#[ink::contract]
mod campaign_registry {
    use ink::storage::Mapping;
    use ink::env::call::{build_call, ExecutionInput, Selector};

    #[derive(scale::Encode, scale::Decode, Clone, Default)]
    #[cfg_attr(feature = "std", derive(scale_info::TypeInfo))]
    pub struct Campaign {
        advertiser: AccountId,
        reward_vault: AccountId,
        payout_per_impression: Balance,
        deposit_remaining: Balance,
        max_impressions: u64,
        approved: bool,
        killed: bool,
    }

    #[ink(storage)]
    pub struct CampaignRegistry {
        owner: AccountId,
        next_id: u64,
        campaigns: Mapping<u64, Campaign>,
    }

    impl CampaignRegistry {
        #[ink(constructor)]
        pub fn new() -> Self {
            Self { owner: Self::env().caller(), next_id: 0, campaigns: Default::default() }
        }

        /// Advertiser submits a campaign with deposit == payout_per_impression * max_impressions.
        #[ink(message, payable)]
        pub fn submit_campaign(&mut self, payout_per_impression: Balance, max_impressions: u64, reward_vault: AccountId) -> u64 {
            let deposit = self.env().transferred_value();
            let required = payout_per_impression * max_impressions as u128;
            assert!(deposit >= required, "Insufficient deposit");

            let id = self.next_id;
            self.next_id += 1;

            self.campaigns.insert(id, &Campaign {
                advertiser: self.env().caller(),
                reward_vault,
                payout_per_impression,
                deposit_remaining: deposit,
                max_impressions,
                approved: false,
                killed: false,
            });
            id
        }

        /// Owner approves campaign manually (MVP‑style governance).
        #[ink(message)]
        pub fn approve(&mut self, id: u64) {
            self.only_owner();
            let mut c = self.fetch(id);
            c.approved = true;
            self.campaigns.insert(id, &c);
        }

        /// Record impressions – called by ImpressionLogger.
        #[ink(message)]
        pub fn record_impression(&mut self, id: u64, user: AccountId, publisher: AccountId, staker: AccountId) {
            let mut c = self.fetch(id);
            assert!(c.approved && !c.killed, "Campaign not active");
            assert!(c.deposit_remaining >= c.payout_per_impression, "Campaign out of funds");

            // Forward DOT to RewardVault (re‑entrancy safe because RewardVault has no callbacks)
            let _ = build_call::<ink::env::DefaultEnvironment>()
                .call(c.reward_vault)
                .transferred_value(c.payout_per_impression)
                .exec_input(ExecutionInput::new(Selector::new([0xDE, 0xAD, 0xF0, 0x0D])) // deposit(..) selector
                            .push_arg(user)
                            .push_arg(publisher)
                            .push_arg(staker))
                .returns::<()>()
                .invoke();

            c.deposit_remaining -= c.payout_per_impression;
            self.campaigns.insert(id, &c);
        }

        /// Emergency stop.
        #[ink(message)]
        pub fn kill(&mut self, id: u64) {
            self.only_owner();
            let mut c = self.fetch(id);
            c.killed = true;
            self.campaigns.insert(id, &c);
            // refund remaining deposit to advertiser
            if c.deposit_remaining > 0 {
                self.env().transfer(c.advertiser, c.deposit_remaining).ok();
                c.deposit_remaining = 0;
            }
        }

        fn fetch(&self, id: u64) -> Campaign { self.campaigns.get(id).unwrap() }
        fn only_owner(&self) { assert_eq!(self.env().caller(), self.owner, "Not owner"); }
    }
}
