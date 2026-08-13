/**
 * Mounts the shared read cache for the whole app.
 */

import { useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient, connectReadCache } from "./queries";

export function ReadCacheProvider({ children }: { children: ReactNode }) {
  // useState, not useMemo: the client must survive every re-render, and a
  // second one would silently split the cache in two.
  const [client] = useState(() => {
    const qc = createQueryClient();
    connectReadCache(qc);
    return qc;
  });

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
