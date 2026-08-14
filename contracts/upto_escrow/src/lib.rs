//! Veridex upto_escrow Soroban Contract
//! License: Apache-2.0
//!
//! Metered billing escrow contract for x402 resource access.
//!
//! Features:
//! - Deposit XLM into escrow for resource access
//! - Resource server can claim accumulated charges
//! - Client can withdraw unused balance
//! - Per-request metering with usage tracking
//! - Authorization via Stellar signatures

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, token, Address, Env, Symbol, Vec,
};

/// Escrow account state
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowAccount {
    /// Client address
    pub client: Address,
    /// Resource server address
    pub resource_server: Address,
    /// Deposited balance (stroops)
    pub balance: i128,
    /// Total consumed amount (stroops)
    pub consumed: i128,
    /// Number of requests settled
    pub request_count: u32,
    /// Last activity timestamp
    pub last_activity: u64,
}

/// Request settlement record
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementRecord {
    /// Request ID (hash or sequence)
    pub request_id: Symbol,
    /// Amount charged (stroops)
    pub amount: i128,
    /// Timestamp
    pub timestamp: u64,
    /// Resource URL or identifier
    pub resource_id: Symbol,
}

/// Storage keys
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Escrow account: (client, resource_server) -> EscrowAccount
    Escrow(Address, Address),
    /// Settlement history: (client, resource_server, request_id) -> SettlementRecord
    Settlement(Address, Address, Symbol),
    /// Admin address
    Admin,
}

/// Contract errors
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Insufficient balance in escrow
    InsufficientBalance = 1,
    /// Escrow account not found
    EscrowNotFound = 2,
    /// Unauthorized access
    Unauthorized = 3,
    /// Invalid amount
    InvalidAmount = 4,
    /// Duplicate request ID
    DuplicateRequest = 5,
}

#[contract]
pub struct UptoEscrowContract;

#[contractimpl]
impl UptoEscrowContract {
    /// Initialize the contract with admin
    pub fn initialize(env: Env, admin: Address) {
        // Ensure not already initialized
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Already initialized");
        }

        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Deposit XLM into escrow for resource access
    ///
    /// # Arguments
    /// * `client` - Client address making the deposit
    /// * `resource_server` - Resource server address
    /// * `amount` - Amount to deposit (stroops)
    pub fn deposit(
        env: Env,
        client: Address,
        resource_server: Address,
        amount: i128,
    ) -> EscrowAccount {
        // Validate inputs
        if amount <= 0 {
            panic!("Invalid amount");
        }

        client.require_auth();

        // Get or create escrow account
        let key = DataKey::Escrow(client.clone(), resource_server.clone());
        let mut escrow = env
            .storage()
            .persistent()
            .get::<DataKey, EscrowAccount>(&key)
            .unwrap_or(EscrowAccount {
                client: client.clone(),
                resource_server: resource_server.clone(),
                balance: 0,
                consumed: 0,
                request_count: 0,
                last_activity: env.ledger().timestamp(),
            });

        // Transfer XLM from client to contract
        let xlm_token = token::TokenClient::new(&env, &env.current_contract_address());
        xlm_token.transfer(&client, &env.current_contract_address(), &amount);

        // Update escrow balance
        escrow.balance += amount;
        escrow.last_activity = env.ledger().timestamp();

        // Save escrow account
        env.storage().persistent().set(&key, &escrow);

        // Extend TTL
        env.storage().persistent().extend_ttl(&key, 100, 518400); // ~30 days

        escrow
    }

    /// Settle a request and charge the escrow
    ///
    /// # Arguments
    /// * `client` - Client address
    /// * `resource_server` - Resource server address (must authorize)
    /// * `request_id` - Unique request identifier
    /// * `amount` - Amount to charge (stroops)
    /// * `resource_id` - Resource identifier
    pub fn settle(
        env: Env,
        client: Address,
        resource_server: Address,
        request_id: Symbol,
        amount: i128,
        resource_id: Symbol,
    ) -> SettlementRecord {
        // Validate inputs
        if amount <= 0 {
            panic!("Invalid amount");
        }

        // Resource server must authorize
        resource_server.require_auth();

        // Get escrow account
        let escrow_key = DataKey::Escrow(client.clone(), resource_server.clone());
        let mut escrow = env
            .storage()
            .persistent()
            .get::<DataKey, EscrowAccount>(&escrow_key)
            .unwrap_or_else(|| panic!("Escrow not found"));

        // Check balance
        if escrow.balance < amount {
            panic!("Insufficient balance");
        }

        // Check for duplicate request
        let settlement_key = DataKey::Settlement(
            client.clone(),
            resource_server.clone(),
            request_id.clone(),
        );
        if env.storage().temporary().has(&settlement_key) {
            panic!("Duplicate request");
        }

        // Create settlement record
        let record = SettlementRecord {
            request_id: request_id.clone(),
            amount,
            timestamp: env.ledger().timestamp(),
            resource_id,
        };

        // Update escrow
        escrow.balance -= amount;
        escrow.consumed += amount;
        escrow.request_count += 1;
        escrow.last_activity = env.ledger().timestamp();

        // Save updates
        env.storage().persistent().set(&escrow_key, &escrow);
        env.storage().temporary().set(&settlement_key, &record);

        // Extend TTL
        env.storage().persistent().extend_ttl(&escrow_key, 100, 518400);
        env.storage().temporary().extend_ttl(&settlement_key, 100, 17280); // ~1 day

        record
    }

    /// Resource server claims accumulated charges
    ///
    /// # Arguments
    /// * `resource_server` - Resource server address (must authorize)
    /// * `client` - Client address
    pub fn claim(env: Env, resource_server: Address, client: Address) -> i128 {
        resource_server.require_auth();

        // Get escrow account
        let escrow_key = DataKey::Escrow(client.clone(), resource_server.clone());
        let mut escrow = env
            .storage()
            .persistent()
            .get::<DataKey, EscrowAccount>(&escrow_key)
            .unwrap_or_else(|| panic!("Escrow not found"));

        let claimable = escrow.consumed;

        if claimable <= 0 {
            panic!("No funds to claim");
        }

        // Transfer XLM to resource server
        let xlm_token = token::TokenClient::new(&env, &env.current_contract_address());
        xlm_token.transfer(&env.current_contract_address(), &resource_server, &claimable);

        // Reset consumed amount
        escrow.consumed = 0;
        escrow.last_activity = env.ledger().timestamp();

        // Save escrow account
        env.storage().persistent().set(&escrow_key, &escrow);
        env.storage().persistent().extend_ttl(&escrow_key, 100, 518400);

        claimable
    }

    /// Client withdraws unused balance
    ///
    /// # Arguments
    /// * `client` - Client address (must authorize)
    /// * `resource_server` - Resource server address
    pub fn withdraw(env: Env, client: Address, resource_server: Address) -> i128 {
        client.require_auth();

        // Get escrow account
        let escrow_key = DataKey::Escrow(client.clone(), resource_server.clone());
        let mut escrow = env
            .storage()
            .persistent()
            .get::<DataKey, EscrowAccount>(&escrow_key)
            .unwrap_or_else(|| panic!("Escrow not found"));

        let withdrawable = escrow.balance;

        if withdrawable <= 0 {
            panic!("No funds to withdraw");
        }

        // Transfer XLM back to client
        let xlm_token = token::TokenClient::new(&env, &env.current_contract_address());
        xlm_token.transfer(&env.current_contract_address(), &client, &withdrawable);

        // Update escrow
        escrow.balance = 0;
        escrow.last_activity = env.ledger().timestamp();

        // Save escrow account
        env.storage().persistent().set(&escrow_key, &escrow);
        env.storage().persistent().extend_ttl(&escrow_key, 100, 518400);

        withdrawable
    }

    /// Get escrow account details
    ///
    /// # Arguments
    /// * `client` - Client address
    /// * `resource_server` - Resource server address
    pub fn get_escrow(
        env: Env,
        client: Address,
        resource_server: Address,
    ) -> Option<EscrowAccount> {
        let key = DataKey::Escrow(client, resource_server);
        env.storage().persistent().get(&key)
    }

    /// Get settlement record
    ///
    /// # Arguments
    /// * `client` - Client address
    /// * `resource_server` - Resource server address
    /// * `request_id` - Request identifier
    pub fn get_settlement(
        env: Env,
        client: Address,
        resource_server: Address,
        request_id: Symbol,
    ) -> Option<SettlementRecord> {
        let key = DataKey::Settlement(client, resource_server, request_id);
        env.storage().temporary().get(&key)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

    #[test]
    fn test_deposit_and_settle() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, UptoEscrowContract);
        let client = UptoEscrowContract::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let client_addr = Address::generate(&env);
        let server_addr = Address::generate(&env);

        // Initialize
        client.initialize(&admin);

        // Deposit
        let escrow = client.deposit(&client_addr, &server_addr, &1_000_000);
        assert_eq!(escrow.balance, 1_000_000);
        assert_eq!(escrow.consumed, 0);

        // Settle request
        let record = client.settle(
            &client_addr,
            &server_addr,
            &Symbol::new(&env, "req1"),
            &100_000,
            &Symbol::new(&env, "resource1"),
        );
        assert_eq!(record.amount, 100_000);

        // Check escrow
        let updated = client.get_escrow(&client_addr, &server_addr).unwrap();
        assert_eq!(updated.balance, 900_000);
        assert_eq!(updated.consumed, 100_000);
        assert_eq!(updated.request_count, 1);
    }

    #[test]
    fn test_claim() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, UptoEscrowContract);
        let client = UptoEscrowContract::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let client_addr = Address::generate(&env);
        let server_addr = Address::generate(&env);

        client.initialize(&admin);
        client.deposit(&client_addr, &server_addr, &1_000_000);
        client.settle(
            &client_addr,
            &server_addr,
            &Symbol::new(&env, "req1"),
            &100_000,
            &Symbol::new(&env, "resource1"),
        );

        // Claim
        let claimed = client.claim(&server_addr, &client_addr);
        assert_eq!(claimed, 100_000);

        // Check escrow
        let escrow = client.get_escrow(&client_addr, &server_addr).unwrap();
        assert_eq!(escrow.consumed, 0);
    }

    #[test]
    fn test_withdraw() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, UptoEscrowContract);
        let client = UptoEscrowContract::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let client_addr = Address::generate(&env);
        let server_addr = Address::generate(&env);

        client.initialize(&admin);
        client.deposit(&client_addr, &server_addr, &1_000_000);

        // Withdraw
        let withdrawn = client.withdraw(&client_addr, &server_addr);
        assert_eq!(withdrawn, 1_000_000);

        // Check escrow
        let escrow = client.get_escrow(&client_addr, &server_addr).unwrap();
        assert_eq!(escrow.balance, 0);
    }

    #[test]
    #[should_panic(expected = "Insufficient balance")]
    fn test_insufficient_balance() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, UptoEscrowContract);
        let client = UptoEscrowContract::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let client_addr = Address::generate(&env);
        let server_addr = Address::generate(&env);

        client.initialize(&admin);
        client.deposit(&client_addr, &server_addr, &100_000);

        // Try to settle more than balance
        client.settle(
            &client_addr,
            &server_addr,
            &Symbol::new(&env, "req1"),
            &200_000,
            &Symbol::new(&env, "resource1"),
        );
    }

    #[test]
    #[should_panic(expected = "Duplicate request")]
    fn test_duplicate_request() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, UptoEscrowContract);
        let client = UptoEscrowContract::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let client_addr = Address::generate(&env);
        let server_addr = Address::generate(&env);

        client.initialize(&admin);
        client.deposit(&client_addr, &server_addr, &1_000_000);

        let req_id = Symbol::new(&env, "req1");
        let resource_id = Symbol::new(&env, "resource1");

        // First settlement
        client.settle(&client_addr, &server_addr, &req_id, &100_000, &resource_id);

        // Try duplicate
        client.settle(&client_addr, &server_addr, &req_id, &100_000, &resource_id);
    }
}
