/**
 * The key behind proposal window guards and signed modal metadata: derived
 * from SURFACES_BUFFER_KEY (never stored in the database), separated by
 * purpose. No buffer key → null, and every caller fails closed.
 */
import { createHmac } from "crypto";
import { bufferKey } from "./buffer-crypto.js";

function derive(purpose: string): Buffer | null {
  try {
    return createHmac("sha256", bufferKey()).update(`surfaces:${purpose}:v1`).digest();
  } catch {
    return null;
  }
}

export const guardKey = () => derive("window-guard");
export const modalKey = () => derive("modal-metadata");
