#![cfg_attr(not(feature = "std"), no_std)]

#[ink::contract]
mod reward_vault {
    use ink::storage::Mapping;

    #[derive(scale::Encode, scale::Decode, Clone, Default)]
    #[cfg_attr(feature = "std", derive(scale_info::TypeInfo))]
    pub struct Split {
        user: u16,
        publisher: u16,
        staker: u16,
        treasury: u16,
    }

    #[ink(storage)]
    pub struct RewardVault {
        owner: AccountId,
        split: Split,
        treasury: AccountId,
        balances: Mapping<AccountId, Balance>,
    }

    impl RewardVault {
        #[ink(constructor)]
        pub fn new(treasury: AccountId) -> Self {
            Self {
                owner: Self::env().caller(),
                split: Split { user: 5000, publisher: 4000, staker: 500, treasury: 500 }, // 10000 == 100%
                treasury,
                balances: Default::default(),
            }
        }

        /// Called by CampaignRegistry to deposit funds for a single campaign impression.
        #[ink(message, payable)]
        pub fn deposit(&mut self, user: AccountId, publisher: AccountId, staker: AccountId) {
            let value = self.env().transferred_value();
            let Split { user: u_p, publisher: p_p, staker: s_p, treasury: t_p } = self.split;
            self.credit(user, value * u_p as u128 / 10_000);
            self.credit(publisher, value * p_p as u128 / 10_000);
            self.credit(staker, value * s_p as u128 / 10_000);
            self.credit(self.treasury, value * t_p as u128 / 10_000);
        }

        /// Anyone can withdraw their accumulated rewards.
        #[ink(message)]
        pub fn withdraw(&mut self) {
            let caller = self.env().caller();
            let amount = self.balances.get(&caller).unwrap_or(0);
            assert!(amount > 0, "Nothing to withdraw");
            self.balances.insert(caller, &0);
            self.env().transfer(caller, amount).unwrap();
        }

        fn credit(&mut self, to: AccountId, amount: Balance) {
            let mut bal = self.balances.get(&to).unwrap_or(0);
            bal += amount;
            self.balances.insert(to, &bal);
        }
    }
}
