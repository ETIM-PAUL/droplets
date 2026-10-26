import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { connectHost, type HostState } from "./host";
import { Spike } from "./spike";

function App() {
  const [host, setHost] = useState<HostState | null>(null);
  useEffect(() => {
    connectHost().then(setHost);
  }, []);

  return (
    <main>
      <h1>Errand</h1>
      {!host && <p>Connecting to Nimiq Pay…</p>}
      {host?.status === "outside-nimiq-pay" && (
        <p>Errand runs inside Nimiq Pay. Open this link from the Mini Apps section of the app.</p>
      )}
      {host?.status === "error" && <p role="alert">{host.message}</p>}
      {host?.status === "ready" && (
        <dl>
          <dt>Network</dt>
          <dd>{host.network}</dd>
          <dt>Account</dt>
          <dd>{host.address}</dd>
          <dt>Balance</dt>
          <dd>{host.balanceNim} NIM</dd>
          <dt>Currency / language</dt>
          <dd>
            {host.fiat} / {host.language}
          </dd>
        </dl>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.hash === "#spike" ? <Spike /> : <App />}
  </StrictMode>,
);
