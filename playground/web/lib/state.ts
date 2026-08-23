/**
 * Shared application state.
 * License: Apache-2.0
 *
 * One completed payment run is the spine of the whole playground: the Wire
 * panel shows what it exchanged, the Receipt panel verifies what it produced,
 * and the Refusals panel reuses its terms to build payments that should fail.
 * Holding it in one place is what stops the panels drifting into telling
 * different stories about the same payment.
 */

import type { PlaygroundConfig } from "./config.js";
import type { PaymentRun } from "./x402.js";
import type { Wallet } from "./wallet.js";

export interface AppState {
  config: PlaygroundConfig;
  wallet?: Wallet;
  /** The most recent successful run, if any. */
  run?: PaymentRun;
  /** Reason codes the visitor has elicited, in the Refusals panel. */
  elicited: Set<string>;
}

type Listener = (state: AppState) => void;

let state: AppState;
let listeners: Listener[] = [];

/**
 * Initializes application state.
 *
 * @param config - Playground configuration
 */
export function initState(config: PlaygroundConfig): void {
  state = { config, elicited: new Set() };
}

/**
 * Reads current state.
 *
 * @returns The application state
 */
export function getState(): AppState {
  return state;
}

/**
 * Applies a change and notifies listeners.
 *
 * @param patch - Fields to change
 */
export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

/**
 * Subscribes to state changes.
 *
 * @param listener - Called on every change
 * @returns A function that unsubscribes
 */
export function subscribe(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
  };
}
