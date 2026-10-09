import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** This server's package version. Built mode bundles into dist/ (package.json
 *  one level up); dev runs src/shared/ (two levels up). */
export const SERVICE_VERSION: string = (() => {
  for (const up of [["..", "package.json"], ["..", "..", "package.json"]]) {
    try {
      const pkg = JSON.parse(readFileSync(join(HERE, ...up), "utf8"));
      if (pkg?.name === "@promptowl/contextnest-community") {
        return pkg.version as string;
      }
    } catch {
      // try the next candidate
    }
  }
  return "unknown";
})();
