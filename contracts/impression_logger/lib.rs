#![cfg_attr(not(feature = "std"), no_std)]

#[ink::contract]
mod impression_logger {
    #[ink(storage)]
    pub struct ImpressionLogger {
        owner: AccountId,
        registry: AccountId,
    }

    impl ImpressionLogger {
        #[ink(constructor)]
        pub fn new(registry: AccountId) -> Self {
            Self { owner: Self::env().caller(), registry }
        }

        /// Off‑chain worker batches (campaign_id, user, publisher, staker) tuples.
        #[ink(message)]
        pub fn batch_record(&mut self, records: Vec<(u64, AccountId, AccountId, AccountId)>) {
            assert_eq!(self.env().caller(), self.owner, "Only owner/aggregator");
            for (id, user, publisher, staker) in records {
                // delegate call into CampaignRegistry
                ink::env::call::build_call::<ink::env::DefaultEnvironment>()
                    .call(self.registry)
                    .exec_input(
                        ink::env::call::ExecutionInput::new(ink::env::call::Selector::new([0x00, 0x00, 0x00, 0x01])) // record_impression selector
                            .push_arg(id)
                            .push_arg(user)
                            .push_arg(publisher)
                            .push_arg(staker),
                    )
                    .returns::<()>()
                    .invoke();
            }
        }
    }
}
