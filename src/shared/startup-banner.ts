import { SERVICE_VERSION } from "./version.js";

/** First line of the startup banner. Reads the real package version (the same
 *  source /health reports) instead of a hard-coded string. */
export function bannerHeading(version: string = SERVICE_VERSION): string {
  return `ContextNest Community Server v${version}`;
}
