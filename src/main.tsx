import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AccountProvider } from "./account/AccountProvider";
import { ConnectionsProvider } from "./account/ConnectionsProvider";
import { SocialProvider } from "./social/SocialProvider";
import { AudienceCirclesProvider } from "./social/AudienceCirclesProvider";
import { ActivityInboxProvider } from "./activity/ActivityInboxProvider";
import "./styles.css";
import "./theme/theme.css";
import "./theme/screens-dark.css";
import "./theme/feature-dark.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AccountProvider>
      <ConnectionsProvider>
        <AudienceCirclesProvider>
          <SocialProvider>
            <ActivityInboxProvider>
              <App />
            </ActivityInboxProvider>
          </SocialProvider>
        </AudienceCirclesProvider>
      </ConnectionsProvider>
    </AccountProvider>
  </React.StrictMode>,
);
