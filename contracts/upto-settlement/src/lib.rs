//! Veridex Soroban Upto Escrow & Settlement Contract for x402
//!
//! License: Apache-2.0
//!
//! This contract enforces the 5 core `upto` payment scheme properties:
//! 1. Maximum Cap Enforcement: A ≤ M (actual amount ≤ max authorized amount)
//! 2. Recipient Binding: Payment can only go to the authorized `payTo` address
//! 3. Single Settlement Lock: Each authorization (nonce) can be consumed exactly once
//! 4. Unspent Refundability: Remaining balance (M - A) is never locked or escrowed
//! 5. Expired Refundability: Authorization expires at `deadline_ledger` without manual claim
//!
//! ## Security Guarantees
//!
//! - Replay Protection: Nonce tracking prevents double-spending
//! - Time-Bounded: Ledger expiration prevents indefinite authorization validity
//! - Amount Validation: On-chain enforcement that actual_amount ≤ max_amount
//! - Recipient Binding: Only the authorized payTo address can receive funds
//! - Single Settlement: Once settled, the nonce is permanently marked as consumed

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
    Symbol,
};

/// Error codes for the Upto Settlement Contract
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum UptoError {
    /// Contract has already been initialized
    AlreadyInitialized = 1,
    /// Authorization has expired (current ledger > deadline)
    AuthorizationExpired = 2,
    /// Actual amount exceeds the maximum authorized cap
    AmountExceedsMaxCap = 3,
    /// Amount is zero or negative
    InvalidAmount = 4,
    /// Nonce has already been used (replay protection)
    NonceAlreadyUsed = 5,
    /// Caller is not authorized to perform this action
    UnauthorizedCaller = 6,
}

/// Storage key for admin address
const STORAGE_KEY_ADMIN: Symbol = symbol_short!("ADMIN");

/// Storage type for nonce tracking (replay protection)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NonceKey {
    pub buyer: Address,
    pub nonce: i128,
}

/// Event emitted on successful settlement
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementEvent {
    pub buyer: Address,
    pub recipient: Address,
    pub token: Address,
    pub actual_amount: i128,
    pub max_amount: i128,
    pub nonce: i128,
}

/// Main Upto Escrow Contract
#[contract]
pub struct UptoEscrowContract;

#[contractimpl]
impl UptoEscrowContract {
    /// Initialize the contract with an admin address
    ///
    /// # Arguments
    /// * `env` - Contract environment
    /// * `admin` - Administrator address
    ///
    /// # Errors
    /// * `UptoError::AlreadyInitialized` - If contract is already initialized
    pub fn initialize(env: Env, admin: Address) -> Result<(), UptoError> {
        if env.storage().instance().has(&STORAGE_KEY_ADMIN) {
            return Err(UptoError::AlreadyInitialized);
        }

        env.storage().instance().set(&STORAGE_KEY_ADMIN, &admin);

        env.events().publish(
            (symbol_short!("init"),),
            (admin,),
        );

        Ok(())
    }

    /// Settle an authorized `upto` payment
    ///
    /// This function enforces all 5 core `upto` properties:
    /// 1. Validates actual_amount ≤ max_amount (cap enforcement)
    /// 2. Transfers only to authorized recipient (binding)
    /// 3. Marks nonce as consumed (single settlement)
    /// 4. Only transfers actual_amount, leaving (max - actual) unencumbered
    /// 5. Checks deadline_ledger expiration
    ///
    /// # Arguments
    /// * `env` - Contract environment
    /// * `buyer` - The account authorizing the payment (signs auth entry)
    /// * `recipient` - The designated payTo recipient
    /// * `token` - The SEP-41 token contract address (e.g. USDC)
    /// * `max_amount` - The maximum authorized spending cap (M)
    /// * `actual_amount` - The actual metered usage amount to settle (A)
    /// * `nonce` - Unique payment authorization identifier
    /// * `deadline_ledger` - Expiration ledger sequence number
    ///
    /// # Returns
    /// * `Ok(())` on successful settlement
    ///
    /// # Errors
    /// * `UptoError::AuthorizationExpired` - Current ledger > deadline
    /// * `UptoError::InvalidAmount` - Amount is zero or negative
    /// * `UptoError::AmountExceedsMaxCap` - actual_amount > max_amount
    /// * `UptoError::NonceAlreadyUsed` - Nonce has been consumed (replay)
    pub fn settle_upto(
        env: Env,
        buyer: Address,
        recipient: Address,
        token: Address,
        max_amount: i128,
        actual_amount: i128,
        nonce: i128,
        deadline_ledger: u32,
    ) -> Result<(), UptoError> {
        // Property #5: Enforce Buyer Authorization (Soroban Auth Entry Signature)
        // The buyer must have signed a Soroban authorization entry authorizing this call
        buyer.require_auth();

        // Property #5: Validate Ledger Expiration Deadline (Expired Refundability)
        // If the current ledger exceeds the deadline, authorization is expired
        if env.ledger().sequence() > deadline_ledger {
            return Err(UptoError::AuthorizationExpired);
        }

        // Property #1: Validate Amount Bounds (Maximum Cap Enforcement)
        // Ensure 0 < actual_amount <= max_amount
        if actual_amount <= 0 {
            return Err(UptoError::InvalidAmount);
        }

        if actual_amount > max_amount {
            return Err(UptoError::AmountExceedsMaxCap);
        }

        // Property #3: Single Settlement Check (Replay Prevention)
        // Check if this nonce has already been used by this buyer
        let nonce_key = NonceKey {
            buyer: buyer.clone(),
            nonce,
        };

        if env.storage().persistent().has(&nonce_key) {
            return Err(UptoError::NonceAlreadyUsed);
        }

        // Mark Nonce as Consumed (with TTL aligned to ledger expiration)
        // Store a boolean flag indicating this nonce is consumed
        env.storage().persistent().set(&nonce_key, &true);

        // Set TTL to extend beyond deadline to prevent premature cleanup
        let ttl_ledgers = deadline_ledger.saturating_sub(env.ledger().sequence())
            .saturating_add(100_000); // Add 100k ledgers (~5-6 days) buffer
        env.storage()
            .persistent()
            .extend_ttl(&nonce_key, ttl_ledgers, ttl_ledgers);

        // Property #2 & #4: Execute On-Chain Transfer of Actual Amount
        // - Only transfers actual_amount (not max_amount), leaving (M - A) unencumbered
        // - Recipient binding: can only transfer to the authorized recipient address
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&buyer, &recipient, &actual_amount);

        // Property #6: Emit Settlement Event for audit trail
        env.events().publish(
            (symbol_short!("settle"), buyer.clone(), recipient.clone()),
            SettlementEvent {
                buyer,
                recipient,
                token,
                actual_amount,
                max_amount,
                nonce,
            },
        );

        Ok(())
    }

    /// Check if a nonce has been used (for verification purposes)
    ///
    /// # Arguments
    /// * `env` - Contract environment
    /// * `buyer` - Buyer address
    /// * `nonce` - Nonce to check
    ///
    /// # Returns
    /// * `true` if nonce has been consumed, `false` otherwise
    pub fn is_nonce_used(env: Env, buyer: Address, nonce: i128) -> bool {
        let nonce_key = NonceKey { buyer, nonce };
        env.storage().persistent().has(&nonce_key)
    }

    /// Get contract admin address
    ///
    /// # Arguments
    /// * `env` - Contract environment
    ///
    /// # Returns
    /// * Admin address if initialized, panics otherwise
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&STORAGE_KEY_ADMIN)
            .expect("Contract not initialized")
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::{Address as _, Ledger}, token, Env};

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let contract_id = env.register(UptoEscrowContract, ());
        let client = UptoEscrowContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);

        // Initialize contract
        client.initialize(&admin);

        // Verify admin is set
        assert_eq!(client.get_admin(), admin);

        // Cannot initialize twice
        assert!(client.try_initialize(&admin).is_err());
    }

    #[test]
    fn test_settle_upto_success() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(UptoEscrowContract, ());
        let client = UptoEscrowContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let recipient = Address::generate(&env);

        // Create token contract
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let token_address = token_id.address();
        let token_client = token::Client::new(&env, &token_address);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        // Initialize
        client.initialize(&admin);

        // Mint tokens to buyer
        token_admin_client.mint(&buyer, &1000);

        // Settle: max_amount = 100, actual_amount = 75
        let max_amount: i128 = 100;
        let actual_amount: i128 = 75;
        let nonce: i128 = 1;
        let deadline_ledger: u32 = env.ledger().sequence() + 1000;

        client.settle_upto(
            &buyer,
            &recipient,
            &token_address,
            &max_amount,
            &actual_amount,
            &nonce,
            &deadline_ledger,
        );

        // Verify transfer occurred
        assert_eq!(token_client.balance(&buyer), 1000 - 75);
        assert_eq!(token_client.balance(&recipient), 75);

        // Verify nonce is marked as used
        assert!(client.is_nonce_used(&buyer, &nonce));
    }

    #[test]
    fn test_settle_upto_exceeds_max() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(UptoEscrowContract, ());
        let client = UptoEscrowContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());

        client.initialize(&admin);

        // Try to settle actual_amount > max_amount (should fail)
        let result = client.try_settle_upto(
            &buyer,
            &recipient,
            &token_id.address(),
            &100, // max
            &150, // actual (exceeds max!)
            &1,
            &(env.ledger().sequence() + 1000),
        );

        assert!(result.is_err());
    }

    #[test]
    fn test_settle_upto_replay_protection() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(UptoEscrowContract, ());
        let client = UptoEscrowContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let token_address = token_id.address();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        client.initialize(&admin);
        token_admin_client.mint(&buyer, &1000);

        let nonce: i128 = 42;
        let deadline = env.ledger().sequence() + 1000;

        // First settlement succeeds
        client.settle_upto(&buyer, &recipient, &token_address, &100, &50, &nonce, &deadline);

        // Second settlement with same nonce should fail
        let result = client.try_settle_upto(
            &buyer,
            &recipient,
            &token_address,
            &100,
            &50,
            &nonce,
            &deadline,
        );

        assert!(result.is_err());
    }

    #[test]
    fn test_settle_upto_expired() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_sequence_number(10);

        let contract_id = env.register(UptoEscrowContract, ());
        let client = UptoEscrowContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());

        client.initialize(&admin);

        // Set deadline in the past
        let deadline = env.ledger().sequence() - 1;

        // Settlement should fail (expired)
        let result = client.try_settle_upto(
            &buyer,
            &recipient,
            &token_id.address(),
            &100,
            &50,
            &1,
            &deadline,
        );

        assert!(result.is_err());
    }
}
