/**
 * Veridex Bazaar Discovery Engine - P2P Module
 * License: Apache-2.0
 *
 * Exports all P2P mesh functionality:
 * - P2PNode: Core libp2p node with GossipSub
 * - Announcer: Message signing and creation
 * - Types: All P2P-related types and schemas
 */

export * from "./types.js";
export * from "./node.js";
export * from "./announcer.js";
