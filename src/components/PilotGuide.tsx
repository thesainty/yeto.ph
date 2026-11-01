import { useState } from "react";
import { Copy, ShieldCheck } from "lucide-react";
import { Modal } from "./ui";
import "./pilot.css";

const feedbackTemplate = `TARA pilot feedback
Device and browser:
What I was trying to do:
Steps to reproduce:
What I expected:
What actually happened:
What felt easy or confusing:
`;

export default function PilotGuide({
  onClose,
  onAccount,
}: {
  onClose: () => void;
  onAccount: () => void;
}) {
  const [copyMessage, setCopyMessage] = useState("");

  async function copyFeedback() {
    try {
      await navigator.clipboard.writeText(feedbackTemplate);
      setCopyMessage("Template copied. Fill it in and send it to the person who invited you.");
    } catch {
      setCopyMessage("Select and copy the template below, then send it to the person who invited you.");
    }
  }

  return (
    <Modal title="Pilot guide" subtitle="Your people. A little closer." onClose={onClose}>
      <div className="pilot-guide">
        <section>
          <h3>Start with your real account</h3>
          <p>Sign in or create an account, confirm your email if prompted, and set your display name and username. Share your username privately with the person testing with you.</p>
          <button className="button button-primary" onClick={onAccount}>Open your account</button>
        </section>
        <section>
          <h3>Try this with a friend</h3>
          <ol>
            <li>In Friends, search their username, send a request, and have them accept.</li>
            <li>In Home, publish an update with no friends selected. It stays private. Then publish another update with your friend selected; ask them to like or comment.</li>
            <li>In Plans, create a meetup and select your friend to invite. Ask them to join and check that their RSVP appears.</li>
          </ol>
          <p>Use Refresh or return to the page to check for changes. Visible lists also update about every 30 seconds. Creating a plan does not create a feed post.</p>
        </section>
        <div className="pilot-boundary">
          <ShieldCheck size={20} aria-hidden="true" />
          <p>Signed-in Friends, Home updates, and Plans use real data. The anonymous preview, Map, and journey tools are demos. TARA does not collect your GPS location. Adding friends or joining plans never turns on location sharing.</p>
        </div>
        <section>
          <h3>Tell us how it felt</h3>
          <p>Send feedback to the person who invited you. Include what you tried and where you got stuck. Leave out passwords, email confirmation links, and other people’s private information.</p>
          <label htmlFor="pilot-feedback-template">Feedback template</label>
          <textarea id="pilot-feedback-template" rows={8} readOnly value={feedbackTemplate} />
          <button className="button button-soft" onClick={() => void copyFeedback()}><Copy size={16} /> Copy feedback template</button>
          {copyMessage && <p role="status">{copyMessage}</p>}
        </section>
      </div>
    </Modal>
  );
}
