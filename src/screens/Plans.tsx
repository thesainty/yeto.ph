import { useState } from "react";
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  Clock3,
  Coffee,
  MapPin,
  Plus,
  Sparkles,
  Users,
} from "lucide-react";
import { AvatarStack } from "../components/ui";
import type { Plan, PersonId } from "../types";
import "./plans.css";

interface PlansProps {
  plans: Plan[];
  onJoin: (id: string) => void;
  onCreate: () => void;
}

function PlanArt({ kind }: { kind: Plan["kind"] }) {
  if (kind === "trip")
    return (
      <svg viewBox="0 0 180 132" fill="none" aria-hidden="true">
        <circle cx="139" cy="29" r="16" fill="#FFD04C" />
        <path d="M0 110 45 37l39 58 25-36 71 63H0Z" fill="#90BBA0" />
        <path d="m0 120 72-62 47 62H0Z" fill="#5D9881" />
        <path d="m36 52 9-15 11 17-12-4-8 2Z" fill="#FFFCF6" />
        <path d="M74 132c-6-28 54-28 31-52" stroke="#EDE3CC" strokeWidth="12" />
        <rect x="112" y="83" width="53" height="25" rx="8" fill="#F4AB80" />
        <path d="m121 83 6-11h21l8 11" fill="#F4AB80" />
        <path d="m129 76-4 7h25l-5-7h-16Z" fill="#DFF1ED" />
        <circle cx="124" cy="108" r="7" fill="#283D43" />
        <circle cx="154" cy="108" r="7" fill="#283D43" />
        <path
          d="M19 96V77m-7 7 7-12 7 12"
          stroke="#477D68"
          strokeWidth="5"
          strokeLinecap="round"
        />
      </svg>
    );
  if (kind === "food")
    return (
      <svg viewBox="0 0 180 132" fill="none" aria-hidden="true">
        <ellipse cx="94" cy="113" rx="68" ry="10" fill="#F0BCB4" />
        <circle cx="93" cy="70" r="48" fill="#FFF9EC" />
        <circle cx="93" cy="70" r="37" stroke="#EBCFAF" strokeWidth="2" />
        <path d="M67 60c11-20 37-19 51-1l-4 26H70l-3-25Z" fill="#E7A05A" />
        <path
          d="M70 60c15-5 27 10 46 1"
          stroke="#A26648"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <circle cx="79" cy="80" r="10" fill="#F3CB7A" />
        <circle cx="103" cy="78" r="13" fill="#F3CB7A" />
        <path
          d="m72 49 7-10m17 11 3-13m14 17 10-9"
          stroke="#7B9F73"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M26 42v58M19 36v18c0 9 14 9 14 0V36"
          stroke="#C06D64"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <path
          d="M155 36v65m0-65c-14 19-12 31 0 31"
          stroke="#C06D64"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <path
          d="m136 17 3 5 6 1-5 4 1 6-5-3-5 3 1-6-4-4 5-1 3-5Z"
          fill="#F4BA58"
        />
      </svg>
    );
  return (
    <svg viewBox="0 0 180 132" fill="none" aria-hidden="true">
      <ellipse cx="88" cy="111" rx="59" ry="10" fill="#E5BB89" />
      <ellipse cx="88" cy="102" rx="53" ry="9" fill="#F8F2E5" />
      <path
        d="M119 48h13c20 0 20 29 0 29h-9"
        stroke="#FFFCF6"
        strokeWidth="9"
      />
      <path
        d="M43 46h83l-6 40c-2 13-13 18-35 18S50 97 48 87l-5-41Z"
        fill="#FFFCF6"
      />
      <ellipse cx="84" cy="47" rx="41" ry="14" fill="#D2AA79" />
      <ellipse cx="84" cy="47" rx="34" ry="10" fill="#996C48" />
      <path
        d="M70 46c12-14 29-4 14 6-15-10 2-20 14-6"
        stroke="#F8DFB9"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M70 25c-7-10 9-12 2-22m23 20c-7-10 9-12 2-22"
        stroke="#F4E5CD"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="m145 19 3 5 6 1-5 4 1 6-5-3-5 3 1-6-4-4 5-1 3-5Z"
        fill="#D49859"
      />
      <circle cx="30" cy="36" r="3" fill="#D49859" />
    </svg>
  );
}

export default function Plans({ plans, onJoin, onCreate }: PlansProps) {
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const shownPlans =
    filter === "mine" ? plans.filter((plan) => plan.joined) : plans;
  const joinedCount = plans.filter((plan) => plan.joined).length;

  return (
    <div className="plans-screen">
      <div className="plans-invitation">
        <div className="plans-invitation-copy">
          <span className="plans-invitation-label">
            <Sparkles size={14} /> GOOD TIMES START HERE
          </span>
          <h2>
            A little plan.
            <br />A lot of memories.
          </h2>
          <p>Make room for your favorite people.</p>
          <button
            className="button button-primary plans-create"
            onClick={onCreate}
          >
            <Plus size={17} /> Make a plan
          </button>
        </div>
        <div className="plans-invitation-art" aria-hidden="true">
          <div className="plans-art-orbit plans-art-orbit-one" />
          <div className="plans-art-orbit plans-art-orbit-two" />
          <div className="plans-art-calendar">
            <div className="plans-art-calendar-top">
              <i />
              <i />
            </div>
            <span>tara!</span>
            <div className="plans-art-calendar-heart">♥</div>
          </div>
          <div className="plans-art-sticker plans-art-sticker-coffee">
            <Coffee size={26} />
          </div>
          <div className="plans-art-sticker plans-art-sticker-spark">
            <Sparkles size={25} />
          </div>
        </div>
      </div>

      <div className="plans-list-heading">
        <h2 className="section-heading">Something to look forward to</h2>
        <span className="plans-count">{plans.length} plans</span>
      </div>
      <div className="plans-tabs" role="group" aria-label="Filter plans">
        <button
          className={filter === "all" ? "plans-tab is-active" : "plans-tab"}
          aria-pressed={filter === "all"}
          onClick={() => setFilter("all")}
        >
          All plans
        </button>
        <button
          className={filter === "mine" ? "plans-tab is-active" : "plans-tab"}
          aria-pressed={filter === "mine"}
          onClick={() => setFilter("mine")}
        >
          My plans <span>{joinedCount}</span>
        </button>
      </div>

      <div className="plans-list">
        {shownPlans.length === 0 ? (
          <div className="card plans-empty">
            <span className="plans-empty-icon">
              <CalendarDays size={30} />
            </span>
            <h3>Your calendar has room for a little fun.</h3>
            <p className="muted">
              Join a plan with friends, or start something of your own.
            </p>
            <button className="button button-primary" onClick={onCreate}>
              <Plus size={17} /> Make a plan
            </button>
            <button
              className="plans-text-button"
              onClick={() => setFilter("all")}
            >
              Explore all plans <ArrowUpRight size={15} />
            </button>
          </div>
        ) : (
          shownPlans.map((plan) => {
            const attendees: PersonId[] =
              plan.joined && !plan.attendees.includes("mika")
                ? [...plan.attendees, "mika"]
                : plan.attendees;
            return (
              <article
                className={`card plans-card plans-card-${plan.kind}`}
                key={plan.id}
              >
                <div className="plans-card-visual">
                  <PlanArt kind={plan.kind} />
                  <span className="plans-kind-label">
                    {plan.kind === "coffee"
                      ? "A coffee catch-up"
                      : plan.kind === "trip"
                        ? "A little adventure"
                        : "Around the table"}
                  </span>
                </div>
                <div className="plans-card-content">
                  <div className="plans-card-title-row">
                    <h3>{plan.title}</h3>
                    {plan.joined && (
                      <span className="plans-going">
                        <Check size={12} /> Going
                      </span>
                    )}
                  </div>
                  <p className="plans-place">
                    <MapPin size={14} /> {plan.place}
                  </p>
                  <div className="plans-when">
                    <span>
                      <CalendarDays size={14} /> {plan.dateLabel}
                    </span>
                    <span>
                      <Clock3 size={14} /> {plan.time}
                    </span>
                  </div>
                  <div className="plans-card-footer">
                    <div className="plans-attendees">
                      <AvatarStack ids={attendees} size={29} />
                      <span>{attendees.length} going</span>
                    </div>
                    <button
                      className={`button ${plan.joined ? "button-soft plans-joined-button" : "button-coral"}`}
                      onClick={() => onJoin(plan.id)}
                      aria-label={`${plan.joined ? "Leave" : "Join"} ${plan.title}`}
                    >
                      {plan.joined ? (
                        <>
                          <Check size={15} /> Joined
                        </>
                      ) : (
                        "Join plan"
                      )}
                    </button>
                  </div>
                </div>
              </article>
            );
          })
        )}
      </div>
      <div className="plans-footer-note">
        <Users size={16} />
        <span>
          Plans are better with your people. Only invited friends can join.
        </span>
      </div>
    </div>
  );
}
