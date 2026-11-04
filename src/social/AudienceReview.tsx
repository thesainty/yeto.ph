import { ShieldCheck, Users } from "lucide-react";
import { useConnections } from "../account/ConnectionsProvider";
import type { Profile } from "../account/types";
import "./audience-review.css";

interface Props {
  selected: string[];
  kind: "post" | "plan" | "poll";
}

interface ReviewProps extends Props {
  friends: Profile[];
  refreshing: boolean;
  unavailable: boolean;
}

function Review({ selected, kind, friends, refreshing, unavailable }: ReviewProps) {
  const recipients = [...new Set(selected)];
  const byId = new Map(friends.map((friend) => [friend.id, friend]));
  const missing = recipients.filter((id) => !byId.has(id)).length;
  const count = recipients.length;
  const privateAudience = count === 0;
  const summary = privateAudience
    ? "Only me"
    : `${kind === "post" ? "Sharing with" : "Inviting"} ${count} friend${count === 1 ? "" : "s"}`;

  return (
    <section className="audience-review" aria-label="Audience review">
      <div className="audience-review-heading" aria-live="polite">
        {privateAudience ? <ShieldCheck size={18} aria-hidden="true" /> : <Users size={18} aria-hidden="true" />}
        <strong>{summary}</strong>
      </div>
      <p>
        {privateAudience
          ? kind === "post"
            ? "This update is visible only to you."
            : kind === "poll"
              ? "This poll is visible only to you. No friends will be invited."
            : "You’re the organizer and only attendee. No friends will be invited."
          : kind === "post"
            ? "You and these selected friends can see this update."
            : kind === "poll"
              ? "You and these invited friends can see this poll, including invitee names and availability totals. Creating a plan keeps this audience."
            : "You and these invited friends can see this plan, including invitee and attendee names."}
      </p>
      {!privateAudience && (
        <>
          <details className="audience-review-details">
            <summary>Review {count} recipient{count === 1 ? "" : "s"}</summary>
            <ul aria-label="Selected recipients">
              {recipients.map((id) => {
                const person = byId.get(id);
                return <li key={id}>
                  {person ? <><span>{person.display_name}</span><small>@{person.username}</small></> : <span className="audience-review-unavailable">Recipient unavailable</span>}
                </li>;
              })}
            </ul>
          </details>
          {(missing > 0 || unavailable) && <p className="audience-review-warning" role="alert">We can’t verify {missing ? `${missing} selected recipient${missing === 1 ? "" : "s"}` : "your selected recipients"} right now. Refresh your friends list and review the selection before publishing.</p>}
          {refreshing && !unavailable && <p className="audience-review-note" role="status">Checking your current friends…</p>}
          <p className="audience-review-note">Publishing saves this recipient list. New friends and later circle changes never add recipients.</p>
        </>
      )}
    </section>
  );
}

/** A read-only review of the same fixed UUID list sent when publishing. */
export default function AudienceReview(props: Props) {
  const { userId, data, refreshing, error } = useConnections();
  return <Review key={userId ?? "anonymous"} {...props} friends={data && !error ? data.friends : []} refreshing={refreshing} unavailable={Boolean(error) || !data} />;
}
