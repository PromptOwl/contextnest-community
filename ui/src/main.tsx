import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "sonner";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ReadCacheProvider } from "./lib/query-provider";
import { BreadcrumbProvider } from "./lib/breadcrumb";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {/* Outside AuthProvider: its login/logout handlers call into the api
          module's invalidation hooks, which this provider registers. */}
      <ReadCacheProvider>
        <AuthProvider>
          <BreadcrumbProvider>
            <App />
          </BreadcrumbProvider>
          {/* Mounted at the root so it never unmounts during view swaps.
              A Toaster inside App's conditional return tree gets torn down
              on logout (auth flip → <Login /> branch), which throws away
              any toast queued in the same tick. */}
          <Toaster richColors position="bottom-right" />
        </AuthProvider>
      </ReadCacheProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
