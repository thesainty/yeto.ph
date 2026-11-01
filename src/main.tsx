import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AccountProvider } from "./account/AccountProvider";
import { ConnectionsProvider } from "./account/ConnectionsProvider";
import { SocialProvider } from "./social/SocialProvider";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AccountProvider>
      <ConnectionsProvider>
        <SocialProvider>
          <App />
        </SocialProvider>
      </ConnectionsProvider>
    </AccountProvider>
  </React.StrictMode>,
);
