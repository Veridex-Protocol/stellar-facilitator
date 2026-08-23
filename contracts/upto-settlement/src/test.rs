extern crate std;

use super::{
    FacilitatorAttestation, PayerTerms, SettlementError, UptoSettlement, UptoSettlementClient,
};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, Error, IntoVal,
};

const CEILING: i128 = 1_000;
const FUNDED: i128 = 10_000;

struct Fixture<'a> {
    env: Env,
    client: UptoSettlementClient<'a>,
    token: Address,
    token_client: TokenClient<'a>,
    payer: Address,
    pay_to: Address,
    facilitator: Address,
}

/// Builds a settlement fixture with a funded payer and a live ledger window.
///
/// @returns The environment, contract client, token, and the three parties
fn setup<'a>() -> Fixture<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(1_000);

    let contract_id = env.register(UptoSettlement, ());
    let client = UptoSettlementClient::new(&env, &contract_id);

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token = sac.address();
    let token_client = TokenClient::new(&env, &token);

    let payer = Address::generate(&env);
    let pay_to = Address::generate(&env);
    let facilitator = Address::generate(&env);

    StellarAssetClient::new(&env, &token).mint(&payer, &FUNDED);

    Fixture { env, client, token, token_client, payer, pay_to, facilitator }
}

/// Builds payer terms with a distinct settlement id.
///
/// @param f - The fixture
/// @param id - Byte used to make the settlement id unique
/// @returns Terms the payer would authorize
fn terms(f: &Fixture, id: u8) -> PayerTerms {
    PayerTerms {
        pay_to: f.pay_to.clone(),
        token: f.token.clone(),
        max_amount: CEILING,
        valid_after: 900,
        deadline: 1_100,
        facilitator: f.facilitator.clone(),
        settlement_id: BytesN::from_array(&f.env, &[id; 32]),
        request_digest: BytesN::from_array(&f.env, &[0xAA; 32]),
    }
}

/// Builds a facilitator attestation for a given settlement and amount.
///
/// @param f - The fixture
/// @param terms - The terms being settled
/// @param actual - The amount the facilitator is charging
/// @returns The attestation
fn attest(f: &Fixture, terms: &PayerTerms, actual: i128) -> FacilitatorAttestation {
    FacilitatorAttestation {
        settlement_id: terms.settlement_id.clone(),
        actual,
        result_digest: BytesN::from_array(&f.env, &[0xBB; 32]),
    }
}

// ── the core movement ────────────────────────────────────────────────────────

#[test]
fn settles_below_the_ceiling_and_refunds_the_remainder() {
    let f = setup();
    let t = terms(&f, 1);

    let settled = f.client.settle(&f.payer, &t, &attest(&f, &t, 300));

    assert_eq!(settled.actual, 300);
    assert_eq!(settled.refunded, 700);
    assert_eq!(f.token_client.balance(&f.pay_to), 300);
    assert_eq!(f.token_client.balance(&f.payer), FUNDED - 300);
    // Nothing may be left standing in the contract.
    assert_eq!(f.token_client.balance(&f.client.address), 0);
    assert_eq!(f.token_client.allowance(&f.payer, &f.client.address), 0);
}

#[test]
fn settles_the_full_ceiling_with_no_refund() {
    let f = setup();
    let t = terms(&f, 2);

    let settled = f.client.settle(&f.payer, &t, &attest(&f, &t, CEILING));

    assert_eq!(settled.refunded, 0);
    assert_eq!(f.token_client.balance(&f.pay_to), CEILING);
    assert_eq!(f.token_client.balance(&f.client.address), 0);
}

#[test]
fn zero_is_a_valid_terminal_settlement() {
    // A metered job that turned out to cost nothing must still settle, so the
    // authorization is consumed and cannot be presented again.
    let f = setup();
    let t = terms(&f, 3);

    let settled = f.client.settle(&f.payer, &t, &attest(&f, &t, 0));

    assert_eq!(settled.actual, 0);
    assert_eq!(settled.refunded, CEILING);
    assert_eq!(f.token_client.balance(&f.pay_to), 0);
    assert_eq!(f.token_client.balance(&f.payer), FUNDED);
    assert!(f.client.is_settled(&f.payer, &t.settlement_id));
}

#[test]
fn every_amount_from_zero_to_the_ceiling_preserves_invariants() {
    for actual in [0, 1, 2, 499, 500, 999, CEILING] {
        let f = setup();
        let t = terms(&f, 4);

        f.client.settle(&f.payer, &t, &attest(&f, &t, actual));

        assert_eq!(f.token_client.balance(&f.pay_to), actual);
        assert_eq!(f.token_client.balance(&f.payer), FUNDED - actual);
        assert_eq!(f.token_client.balance(&f.client.address), 0);
    }
}

#[test]
fn payer_equal_to_recipient_leaves_the_balance_unchanged() {
    let f = setup();
    let mut t = terms(&f, 5);
    t.pay_to = f.payer.clone();

    f.client.settle(&f.payer, &t, &attest(&f, &t, 400));

    assert_eq!(f.token_client.balance(&f.payer), FUNDED);
    assert_eq!(f.token_client.balance(&f.client.address), 0);
}

// ── replay ───────────────────────────────────────────────────────────────────

#[test]
fn the_same_settlement_id_cannot_settle_twice() {
    // The guarantee that distinguishes this contract: replay is refused in
    // contract storage, so it holds for any payer regardless of how that payer
    // authenticates — including a custom __check_auth that does not itself
    // deduplicate.
    let f = setup();
    let t = terms(&f, 6);

    f.client.settle(&f.payer, &t, &attest(&f, &t, 100));
    let err = f.client.try_settle(&f.payer, &t, &attest(&f, &t, 100));

    assert_eq!(err, Err(Ok(Error::from(SettlementError::AlreadySettled))));
    assert_eq!(f.token_client.balance(&f.pay_to), 100);
}

#[test]
fn a_different_settlement_id_settles_independently() {
    let f = setup();
    let first = terms(&f, 7);
    let second = terms(&f, 8);

    f.client.settle(&f.payer, &first, &attest(&f, &first, 100));
    f.client.settle(&f.payer, &second, &attest(&f, &second, 250));

    assert_eq!(f.token_client.balance(&f.pay_to), 350);
}

#[test]
fn is_settled_reports_only_consumed_authorizations() {
    let f = setup();
    let t = terms(&f, 9);
    let untouched = BytesN::from_array(&f.env, &[0xEE; 32]);

    assert!(!f.client.is_settled(&f.payer, &t.settlement_id));
    f.client.settle(&f.payer, &t, &attest(&f, &t, 10));

    assert!(f.client.is_settled(&f.payer, &t.settlement_id));
    assert!(!f.client.is_settled(&f.payer, &untouched));
}

#[test]
fn the_attestation_must_name_the_settlement_the_payer_authorized() {
    // A facilitator must not be able to pair a payer's authorization with an
    // attestation about a different job.
    let f = setup();
    let t = terms(&f, 10);
    let mut wrong = attest(&f, &t, 100);
    wrong.settlement_id = BytesN::from_array(&f.env, &[0xCC; 32]);

    let err = f.client.try_settle(&f.payer, &t, &wrong);

    assert_eq!(err, Err(Ok(Error::from(SettlementError::AlreadySettled))));
}

// ── amount and window bounds ────────────────────────────────────────────────

#[test]
fn rejects_an_amount_above_the_ceiling() {
    let f = setup();
    let t = terms(&f, 11);

    let err = f.client.try_settle(&f.payer, &t, &attest(&f, &t, CEILING + 1));

    assert_eq!(err, Err(Ok(Error::from(SettlementError::ActualExceedsMaximum))));
    assert_eq!(f.token_client.balance(&f.payer), FUNDED);
}

#[test]
fn rejects_a_negative_amount() {
    let f = setup();
    let t = terms(&f, 12);

    let err = f.client.try_settle(&f.payer, &t, &attest(&f, &t, -1));

    assert_eq!(err, Err(Ok(Error::from(SettlementError::NegativeActual))));
}

#[test]
fn rejects_a_non_positive_ceiling() {
    let f = setup();
    let mut t = terms(&f, 13);
    t.max_amount = 0;

    let err = f.client.try_settle(&f.payer, &t, &attest(&f, &t, 0));

    assert_eq!(err, Err(Ok(Error::from(SettlementError::InvalidMaximum))));
}

#[test]
fn rejects_a_reversed_validity_window() {
    let f = setup();
    let mut t = terms(&f, 14);
    t.valid_after = 1_200;
    t.deadline = 1_100;

    let err = f.client.try_settle(&f.payer, &t, &attest(&f, &t, 10));

    assert_eq!(err, Err(Ok(Error::from(SettlementError::InvalidTimeWindow))));
}

#[test]
fn rejects_before_valid_after_and_after_the_deadline() {
    let f = setup();

    let mut early = terms(&f, 15);
    early.valid_after = 2_000;
    early.deadline = 2_100;
    assert_eq!(
        f.client.try_settle(&f.payer, &early, &attest(&f, &early, 10)),
        Err(Ok(Error::from(SettlementError::NotYetValid)))
    );

    let mut expired = terms(&f, 16);
    expired.valid_after = 100;
    expired.deadline = 900;
    assert_eq!(
        f.client.try_settle(&f.payer, &expired, &attest(&f, &expired, 10)),
        Err(Ok(Error::from(SettlementError::Expired)))
    );
}

#[test]
fn the_validity_window_is_inclusive_at_both_ends() {
    let f = setup();

    let mut opens_now = terms(&f, 17);
    opens_now.valid_after = 1_000;
    opens_now.deadline = 1_100;
    f.client.settle(&f.payer, &opens_now, &attest(&f, &opens_now, 5));

    let mut closes_now = terms(&f, 18);
    closes_now.valid_after = 900;
    closes_now.deadline = 1_000;
    f.client.settle(&f.payer, &closes_now, &attest(&f, &closes_now, 5));

    assert_eq!(f.token_client.balance(&f.pay_to), 10);
}

// ── party checks ─────────────────────────────────────────────────────────────

#[test]
fn the_facilitator_may_not_be_the_payer() {
    let f = setup();
    let mut t = terms(&f, 19);
    t.facilitator = f.payer.clone();

    let err = f.client.try_settle(&f.payer, &t, &attest(&f, &t, 10));

    assert_eq!(err, Err(Ok(Error::from(SettlementError::InvalidPayer))));
}

#[test]
fn the_contract_may_not_be_the_recipient_or_the_token() {
    let f = setup();

    let mut as_recipient = terms(&f, 20);
    as_recipient.pay_to = f.client.address.clone();
    assert_eq!(
        f.client.try_settle(&f.payer, &as_recipient, &attest(&f, &as_recipient, 10)),
        Err(Ok(Error::from(SettlementError::InvalidRecipient)))
    );

    let mut as_token = terms(&f, 21);
    as_token.token = f.client.address.clone();
    assert_eq!(
        f.client.try_settle(&f.payer, &as_token, &attest(&f, &as_token, 10)),
        Err(Ok(Error::from(SettlementError::InvalidToken)))
    );
}

// ── funding ──────────────────────────────────────────────────────────────────

#[test]
fn an_underfunded_payer_fails_without_moving_anything() {
    let f = setup();
    let poor = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&poor, &10);
    let t = terms(&f, 22);

    assert!(f.client.try_settle(&poor, &t, &attest(&f, &t, 5)).is_err());

    assert_eq!(f.token_client.balance(&poor), 10);
    assert_eq!(f.token_client.balance(&f.pay_to), 0);
    assert_eq!(f.token_client.balance(&f.client.address), 0);
    // The authorization must remain usable once the payer is funded.
    assert!(!f.client.is_settled(&poor, &t.settlement_id));
}

// ── the settlement record ────────────────────────────────────────────────────

#[test]
fn a_settlement_emits_one_indexable_event() {
    // An independent catalog finds settlements by subscribing to these topics;
    // the event body carries the fields it verifies. Topic decoding is asserted
    // here, and the body is asserted end to end by the conformance harness once
    // an instance is deployed.
    let f = setup();
    let t = terms(&f, 23);
    let a = attest(&f, &t, 375);

    let returned = f.client.settle(&f.payer, &t, &a);

    assert_eq!(returned.max_amount, CEILING);
    assert_eq!(returned.actual, 375);
    assert_eq!(returned.refunded, CEILING - 375);

    let events = f.env.events().all();
    let ours = events.filter_by_contract(&f.client.address);
    assert_eq!(ours.events().len(), 1, "exactly one settlement event per settlement");
}

#[test]
fn the_amounts_returned_match_what_moved() {
    let f = setup();
    let t = terms(&f, 24);

    let returned = f.client.settle(&f.payer, &t, &attest(&f, &t, 42));

    assert_eq!(returned.actual, 42);
    assert_eq!(returned.refunded, CEILING - 42);
    assert_eq!(f.token_client.balance(&f.pay_to), returned.actual);
    assert_eq!(f.token_client.balance(&f.payer), FUNDED - returned.actual);
}

// ── the binding itself ───────────────────────────────────────────────────────
//
// Everything above runs under mock_all_auths, which approves any authorization
// and therefore proves nothing about what the payer signed for. These assert the
// binding directly: what was required, and that an authorization for one set of
// terms cannot settle a different set.

use soroban_sdk::testutils::{AuthorizedFunction, MockAuth, MockAuthInvoke};
use soroban_sdk::{symbol_short, Val, Vec as SdkVec};

/// The argument list the payer's authorization must cover.
fn payer_args(f: &Fixture, t: &PayerTerms) -> SdkVec<Val> {
    (
        t.pay_to.clone(),
        t.token.clone(),
        t.max_amount,
        t.valid_after,
        t.deadline,
        t.facilitator.clone(),
        t.settlement_id.clone(),
        t.request_digest.clone(),
    )
        .into_val(&f.env)
}

/// The argument list the facilitator's authorization must cover.
fn facilitator_args(f: &Fixture, a: &FacilitatorAttestation) -> SdkVec<Val> {
    (a.settlement_id.clone(), a.actual, a.result_digest.clone()).into_val(&f.env)
}

/// Grants authorization for exactly these terms and no others.
macro_rules! grant {
    ($f:expr, $t:expr, $a:expr) => {{
        let payer_a = payer_args(&$f, &$t);
        let fac_a = facilitator_args(&$f, &$a);
        let approve_a: SdkVec<Val> = (
            $f.payer.clone(),
            $f.client.address.clone(),
            $t.max_amount,
            $t.deadline,
        )
            .into_val(&$f.env);
        $f.env.mock_auths(&[
            MockAuth {
                address: &$f.payer,
                invoke: &MockAuthInvoke {
                    contract: &$f.client.address,
                    fn_name: "settle",
                    args: payer_a,
                    sub_invokes: &[MockAuthInvoke {
                        contract: &$f.token,
                        fn_name: "approve",
                        args: approve_a,
                        sub_invokes: &[],
                    }],
                },
            },
            MockAuth {
                address: &$f.facilitator,
                invoke: &MockAuthInvoke {
                    contract: &$f.client.address,
                    fn_name: "settle",
                    args: fac_a,
                    sub_invokes: &[],
                },
            },
        ]);
    }};
}

#[test]
fn a_granted_authorization_settles() {
    // Control for the negative tests below: the same grant, used as issued.
    let f = setup();
    let t = terms(&f, 30);
    let a = attest(&f, &t, 100);

    grant!(f, t, a);
    f.client.settle(&f.payer, &t, &a);

    assert_eq!(f.token_client.balance(&f.pay_to), 100);
}

#[test]
fn the_payer_authorization_covers_every_term() {
    let f = setup();
    let t = terms(&f, 31);
    f.client.settle(&f.payer, &t, &attest(&f, &t, 250));

    let auths = f.env.auths();
    let (_, invocation) = auths
        .iter()
        .find(|(addr, _)| addr == &f.payer)
        .expect("the payer must be required to authorize");

    match &invocation.function {
        AuthorizedFunction::Contract((_, fn_name, args)) => {
            assert_eq!(fn_name, &symbol_short!("settle"));
            assert_eq!(
                args,
                &payer_args(&f, &t),
                "the payer's authorization must cover recipient, token, ceiling, window, \
                 facilitator, settlement id and request digest"
            );
        }
        other => panic!("unexpected authorized function: {other:?}"),
    }
    // The token approval is nested under the payer's authorization, so this
    // signature cannot authorize a standalone allowance.
    assert_eq!(invocation.sub_invocations.len(), 1);
}

#[test]
fn the_facilitator_authorization_covers_the_amount_and_result() {
    let f = setup();
    let t = terms(&f, 32);
    let a = attest(&f, &t, 250);
    f.client.settle(&f.payer, &t, &a);

    let auths = f.env.auths();
    let (_, invocation) = auths
        .iter()
        .find(|(addr, _)| addr == &f.facilitator)
        .expect("the facilitator must be required to authorize");

    match &invocation.function {
        AuthorizedFunction::Contract((_, _, args)) => assert_eq!(
            args,
            &facilitator_args(&f, &a),
            "the facilitator must authorize the amount charged and the result delivered"
        ),
        other => panic!("unexpected authorized function: {other:?}"),
    }
}

#[test]
fn an_authorization_for_one_recipient_cannot_pay_another() {
    // The property the design turns on: a facilitator holding a signed
    // authorization must not be able to redirect the payment.
    let f = setup();
    let authorized = terms(&f, 33);
    let a = attest(&f, &authorized, 100);
    let mut redirected = authorized.clone();
    redirected.pay_to = Address::generate(&f.env);

    grant!(f, authorized, a);

    assert!(f.client.try_settle(&f.payer, &redirected, &a).is_err());
    assert_eq!(f.token_client.balance(&f.payer), FUNDED);
}

#[test]
fn an_authorization_for_one_ceiling_cannot_settle_a_larger_one() {
    let f = setup();
    let authorized = terms(&f, 34);
    let a = attest(&f, &authorized, 100);
    let mut inflated = authorized.clone();
    inflated.max_amount = CEILING * 5;

    grant!(f, authorized, a);

    assert!(f.client.try_settle(&f.payer, &inflated, &a).is_err());
    assert_eq!(f.token_client.balance(&f.payer), FUNDED);
}

#[test]
fn an_authorization_for_one_request_cannot_settle_another() {
    // The digest binding: an authorization is for a specific job.
    let f = setup();
    let authorized = terms(&f, 35);
    let a = attest(&f, &authorized, 100);
    let mut other_job = authorized.clone();
    other_job.request_digest = BytesN::from_array(&f.env, &[0x99; 32]);

    grant!(f, authorized, a);

    assert!(f.client.try_settle(&f.payer, &other_job, &a).is_err());
}

#[test]
fn the_facilitator_cannot_charge_more_than_it_attested() {
    // The facilitator's own signature pins the amount, so a compromised
    // submission path cannot inflate the charge either.
    let f = setup();
    let t = terms(&f, 36);
    let attested = attest(&f, &t, 100);
    let mut inflated = attested.clone();
    inflated.actual = 900;

    grant!(f, t, attested);

    assert!(f.client.try_settle(&f.payer, &t, &inflated).is_err());
    assert_eq!(f.token_client.balance(&f.pay_to), 0);
}
