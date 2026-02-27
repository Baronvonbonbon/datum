// Chrome extension message types for background ↔ popup ↔ content communication

import { Claim, SettlementResult, StoredSettings } from "./types";

// Messages sent FROM content script TO background
export type ContentToBackground =
  | { type: "IMPRESSION_RECORDED"; campaignId: string; url: string; category: string; publisherAddress: string }
  | { type: "GET_ACTIVE_CAMPAIGNS" };

// Messages sent FROM popup TO background
export type PopupToBackground =
  | { type: "WALLET_CONNECTED"; address: string }
  | { type: "WALLET_DISCONNECTED" }
  | { type: "SUBMIT_CLAIMS"; userAddress: string }
  | { type: "SIGN_FOR_RELAY"; userAddress: string; campaignId: string }
  | { type: "GET_QUEUE_STATE" }
  | { type: "CLEAR_QUEUE" };

// Messages sent FROM background TO popup
export type BackgroundToPopup =
  | { type: "QUEUE_UPDATED"; pendingCount: number; pendingEarningsPlanck: string }
  | { type: "SUBMIT_RESULT"; result: SettlementResult }
  | { type: "SIGN_REQUEST"; claims: Claim[]; campaignId: string; deadline: number }
  | { type: "ERROR"; message: string };

// Generic sendMessage wrapper for type safety
export function sendToBackground(msg: ContentToBackground | PopupToBackground): void {
  chrome.runtime.sendMessage(msg);
}
