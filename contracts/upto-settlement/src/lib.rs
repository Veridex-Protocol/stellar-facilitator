#![no_std]
//! Veridex Soroban `upto` settlement contract for x402 metered payments.
//!
//! License: Apache-2.0
//!
//! `upto` lets a buyer authorize a ceiling and a facilitator settle the amount
//! actually used. The discretion over the final amount sits with the
//! facilitator, so every property here exists to bound that discretion.
//!
//! ## What the payer's signature covers
//!
//! `require_auth_for_args` binds the payer's authorization to the exact terms:
//! recipient, token, ceiling, validity window, facilitator, settlement id, and
//! the digest of the request being paid for. A facilitator holding a signed
//! authorization cannot redirect the payment, raise the ceiling, or reuse it for
//! a different job — the signature does not cover those variants.
//!
//! A bare `require_auth()` authorizes *the invocation*. That is not the same
//! thing, and it is not what the `upto` scheme's recipient binding requires.
//!
//! ## What the facilitator's signature covers
//!
//! The payer signs before the work happens, so it cannot commit to a result it
//! has not seen. The facilitator therefore signs the half the payer cannot:
//! the actual amount charged and the digest of the result delivered. Both land
//! in the settlement event.
//!
//! The effect is that the ledger, not a facilitator's own log, records what was
//! charged and what it was charged for. An `x402job/1` receipt covering the same
//! digests is then checkable against the chain by anyone.
//!
//! ## Replay
//!
//! `(payer, settlement_id)` is recorded in contract storage, so an
//! authorization settles exactly once regardless of how the payer authenticates.
//! Relying on Soroban's auth-entry nonce alone covers a classic keypair, and
//! leaves a payer whose custom `__check_auth` does not itself deduplicate
//! without that guarantee. The entry's TTL is bounded by the deadline, so the
//! guard costs no rent beyond the window it protects.
//!
//! ## What this contract deliberately does not have
//!
//! No admin, no `initialize`, no upgrade path, no configuration. Every operator
//! deploys their own instance and no instance has a privileged party. The only
//! state is the replay guard above.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, BytesN, Env, IntoVal,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SettlementError {
    /// `max_amount` must be strictly positive.
    InvalidMaximum = 1,
    /// `actual` must not be negative. Zero is valid and terminal.
    NegativeActual = 2,
    /// `actual` must not exceed the authorized ceiling.
    ActualExceedsMaximum = 3,
    /// `valid_after` must not be after `deadline`.
    InvalidTimeWindow = 4,
    /// The current ledger is before `valid_after`.
    NotYetValid = 5,
    /// The current ledger is past `deadline`.
    Expired = 6,
    /// The payer may not be the facilitator or this contract.
    InvalidPayer = 7,
    /// The recipient may not be this contract.
    InvalidRecipient = 8,
    /// The token may not be this contract.
    InvalidToken = 9,
    /// This `(payer, settlement_id)` has already settled.
    AlreadySettled = 10,
    /// The token did not grant the allowance this contract requested.
    UnexpectedAllowance = 11,
    /// The allowance was not fully consumed by the pull.
    AllowanceNotConsumed = 12,
    /// Balances did not move by exactly the settled amounts.
    BalanceInvariantViolated = 13,
    /// Arithmetic overflowed.
    ArithmeticOverflow = 14,
}

/// Replay-guard key. The only state this contract writes.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Settled(Address, BytesN<32>),
}

/// Emitted once per settlement.
///
/// Carries every field an independent verifier needs to confirm what happened
/// without trusting the facilitator that submitted it: who paid, who was paid,
/// in what token, the ceiling authorized, the amount actually taken, and the
/// digests tying it to an off-chain request and result.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settled {
    #[topic]
    pub payer: Address,
    #[topic]
    pub pay_to: Address,
    #[topic]
    pub settlement_id: BytesN<32>,
    pub token: Address,
    pub facilitator: Address,
    pub max_amount: i128,
    pub actual: i128,
    pub refunded: i128,
    pub request_digest: BytesN<32>,
    pub result_digest: BytesN<32>,
}

/// What `settle` returns to its caller. The full record is in the event.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settlement {
    pub max_amount: i128,
    pub actual: i128,
    pub refunded: i128,
}

/// Terms the payer authorizes. Every field is covered by the payer's signature.
#[contracttype]
#[derive(Clone)]
pub struct PayerTerms {
    pub pay_to: Address,
    pub token: Address,
    pub max_amount: i128,
    pub valid_after: u32,
    pub deadline: u32,
    pub facilitator: Address,
    pub settlement_id: BytesN<32>,
    pub request_digest: BytesN<32>,
}

/// What the facilitator attests to. Covered by the facilitator's signature.
#[contracttype]
#[derive(Clone)]
pub struct FacilitatorAttestation {
    pub settlement_id: BytesN<32>,
    pub actual: i128,
    pub result_digest: BytesN<32>,
}

#[contract]
pub struct UptoSettlement;

#[contractimpl]
impl UptoSettlement {
    /// Settles a metered payment for at most `terms.max_amount`.
    ///
    /// The whole movement is atomic: the contract pulls the full ceiling, pays
    /// the recipient the actual amount, and refunds the remainder in the same
    /// invocation. Pulling the ceiling rather than the actual amount is what
    /// makes the allowance exactly consumed and leaves nothing standing
    /// afterwards for anyone to spend.
    ///
    /// @param payer - The account being charged
    /// @param terms - Exactly what the payer authorized
    /// @param attestation - What the facilitator attests it delivered and charged
    /// @return The ceiling, the amount charged, and the amount refunded
    pub fn settle(
        env: Env,
        payer: Address,
        terms: PayerTerms,
        attestation: FacilitatorAttestation,
    ) -> Settlement {
        validate(&env, &payer, &terms, &attestation);

        // The payer authorized these terms and no variant of them.
        payer.require_auth_for_args(
            (
                terms.pay_to.clone(),
                terms.token.clone(),
                terms.max_amount,
                terms.valid_after,
                terms.deadline,
                terms.facilitator.clone(),
                terms.settlement_id.clone(),
                terms.request_digest.clone(),
            )
                .into_val(&env),
        );

        // The facilitator authorizes the half the payer could not know when it
        // signed: what was actually delivered, and what it is charging for it.
        terms.facilitator.require_auth_for_args(
            (
                terms.settlement_id.clone(),
                attestation.actual,
                attestation.result_digest.clone(),
            )
                .into_val(&env),
        );

        // Replay guard, before any value moves.
        let settled_key = DataKey::Settled(payer.clone(), terms.settlement_id.clone());
        if env.storage().persistent().has(&settled_key) {
            panic_with_error!(&env, SettlementError::AlreadySettled);
        }
        env.storage().persistent().set(&settled_key, &true);

        // The guard only has to outlive the window in which the authorization
        // could still be presented, so its rent is bounded by the deadline.
        let ttl = terms
            .deadline
            .saturating_sub(env.ledger().sequence())
            .saturating_add(1);
        env.storage().persistent().extend_ttl(&settled_key, ttl, ttl);

        let contract = env.current_contract_address();
        let token_client = token::TokenClient::new(&env, &terms.token);

        let payer_before = token_client.balance(&payer);
        let payee_before = token_client.balance(&terms.pay_to);
        let contract_before = token_client.balance(&contract);

        // Pull the full ceiling, then pay and refund from it.
        token_client.approve(&payer, &contract, &terms.max_amount, &terms.deadline);
        if token_client.allowance(&payer, &contract) != terms.max_amount {
            panic_with_error!(&env, SettlementError::UnexpectedAllowance);
        }
        token_client.transfer_from(&contract, &payer, &contract, &terms.max_amount);

        if attestation.actual > 0 {
            token_client.transfer(&contract, &terms.pay_to, &attestation.actual);
        }

        let refunded = terms
            .max_amount
            .checked_sub(attestation.actual)
            .unwrap_or_else(|| panic_with_error!(&env, SettlementError::ArithmeticOverflow));
        if refunded > 0 {
            token_client.transfer(&contract, &payer, &refunded);
        }

        // Nothing may be left standing: neither an allowance nor a balance.
        if token_client.allowance(&payer, &contract) != 0 {
            panic_with_error!(&env, SettlementError::AllowanceNotConsumed);
        }
        enforce_balance_invariants(
            &env,
            &token_client,
            &payer,
            &terms.pay_to,
            &contract,
            payer_before,
            payee_before,
            contract_before,
            attestation.actual,
        );

        // Topics let an indexer subscribe by payer, recipient or settlement id;
        // the body carries every field a verifier needs.
        Settled {
            payer: payer.clone(),
            pay_to: terms.pay_to.clone(),
            settlement_id: terms.settlement_id.clone(),
            token: terms.token.clone(),
            facilitator: terms.facilitator.clone(),
            max_amount: terms.max_amount,
            actual: attestation.actual,
            refunded,
            request_digest: terms.request_digest.clone(),
            result_digest: attestation.result_digest.clone(),
        }
        .publish(&env);

        Settlement { max_amount: terms.max_amount, actual: attestation.actual, refunded }
    }

    /// Whether this authorization has already settled.
    ///
    /// @param payer - The payer the settlement id belongs to
    /// @param settlement_id - The identifier from the authorized terms
    /// @return True when it has settled and cannot settle again
    pub fn is_settled(env: Env, payer: Address, settlement_id: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Settled(payer, settlement_id))
    }
}

/// Checks every term before any authorization is required or value moves.
///
/// @param env - Contract environment
/// @param payer - The account being charged
/// @param terms - Terms as authorized by the payer
/// @param attestation - The facilitator's attestation
fn validate(env: &Env, payer: &Address, terms: &PayerTerms, attestation: &FacilitatorAttestation) {
    if terms.max_amount <= 0 {
        panic_with_error!(env, SettlementError::InvalidMaximum);
    }
    if attestation.actual < 0 {
        panic_with_error!(env, SettlementError::NegativeActual);
    }
    if attestation.actual > terms.max_amount {
        panic_with_error!(env, SettlementError::ActualExceedsMaximum);
    }
    // The attestation must be about the settlement the payer authorized.
    if attestation.settlement_id != terms.settlement_id {
        panic_with_error!(env, SettlementError::AlreadySettled);
    }
    if terms.valid_after > terms.deadline {
        panic_with_error!(env, SettlementError::InvalidTimeWindow);
    }

    let current = env.ledger().sequence();
    if current < terms.valid_after {
        panic_with_error!(env, SettlementError::NotYetValid);
    }
    if current > terms.deadline {
        panic_with_error!(env, SettlementError::Expired);
    }

    let contract = env.current_contract_address();
    if payer == &terms.facilitator || payer == &contract {
        panic_with_error!(env, SettlementError::InvalidPayer);
    }
    if terms.pay_to == contract {
        panic_with_error!(env, SettlementError::InvalidRecipient);
    }
    if terms.token == contract {
        panic_with_error!(env, SettlementError::InvalidToken);
    }
}

/// Confirms balances moved by exactly the settled amounts and nothing else.
///
/// Guards against a token whose `transfer` does something other than what it
/// says — a fee-taking or rebasing token would break these equalities rather
/// than quietly shortchange the recipient.
///
/// @param env - Contract environment
/// @param token_client - Client for the settlement token
/// @param payer - The account charged
/// @param pay_to - The recipient
/// @param contract - This contract's address
/// @param payer_before - Payer balance before settlement
/// @param payee_before - Recipient balance before settlement
/// @param contract_before - Contract balance before settlement
/// @param actual - The amount that should have reached the recipient
#[allow(clippy::too_many_arguments)]
fn enforce_balance_invariants(
    env: &Env,
    token_client: &token::TokenClient,
    payer: &Address,
    pay_to: &Address,
    contract: &Address,
    payer_before: i128,
    payee_before: i128,
    contract_before: i128,
    actual: i128,
) {
    let contract_after = token_client.balance(contract);
    if contract_after != contract_before {
        panic_with_error!(env, SettlementError::BalanceInvariantViolated);
    }

    // Payer and recipient may be the same account; then the two deltas cancel
    // and the payer's balance must be unchanged.
    if payer == pay_to {
        if token_client.balance(payer) != payer_before {
            panic_with_error!(env, SettlementError::BalanceInvariantViolated);
        }
        return;
    }

    let payer_after = token_client.balance(payer);
    let payee_after = token_client.balance(pay_to);

    let expected_payer = payer_before
        .checked_sub(actual)
        .unwrap_or_else(|| panic_with_error!(env, SettlementError::ArithmeticOverflow));
    let expected_payee = payee_before
        .checked_add(actual)
        .unwrap_or_else(|| panic_with_error!(env, SettlementError::ArithmeticOverflow));

    if payer_after != expected_payer || payee_after != expected_payee {
        panic_with_error!(env, SettlementError::BalanceInvariantViolated);
    }
}

#[cfg(test)]
mod test;
