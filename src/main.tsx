import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AccountProvider } from "./account/AccountProvider";
import { ConnectionsProvider } from "./account/ConnectionsProvider";
import { SocialProvider } from "./social/SocialProvider";
import { AudienceCirclesProvider } from "./social/AudienceCirclesProvider";
import { ActivityInboxProvider } from "./activity/ActivityInboxProvider";
import { PollsProvider } from "./polls/PollsProvider";
import { RemindersProvider } from "./planning/RemindersProvider";
import { ConversationsProvider } from "./conversations/ConversationsProvider";
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
            <PollsProvider>
              <RemindersProvider>
                <ConversationsProvider>
                  <ActivityInboxProvider>
                    <App />
                  </ActivityInboxProvider>
                </ConversationsProvider>
              </RemindersProvider>
            </PollsProvider>
          </SocialProvider>
        </AudienceCirclesProvider>
      </ConnectionsProvider>
    </AccountProvider>
  </React.StrictMode>,
);
