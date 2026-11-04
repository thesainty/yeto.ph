"""Availability-poll browser contracts against intercepted fictional accounts.

Use the two local servers documented in accounts.py. PostgreSQL permissions are
tested separately; this fixture never sends hosted requests, emails, or data.
"""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import time
import unittest
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect
import accounts
import circles
import social

POLL_ID = "eeeeeeee-eeee-4eee-8eee-000000000001"
OLD_POLL_ID = "eeeeeeee-eeee-4eee-8eee-000000000099"
OPTION_A = "ffffffff-ffff-4fff-8fff-000000000001"
OPTION_B = "ffffffff-ffff-4fff-8fff-000000000002"


class MockPollService(social.MockSocialService):
    """UI fixtures only; server authorization is verified by database tests."""
    def __init__(self):
        super().__init__()
        self.polls_by_user = {}
        self.target_polls_by_user = {}
        self.poll_serial = 0
        self.poll_error = None
        self.poll_mutation_error = None
        self.poll_target_error = None
        self.hold_poll_snapshot = False
        self.held_poll_snapshots = []
        self.hold_poll_vote = False
        self.held_poll_votes = []
        self.hold_poll_target = False
        self.held_poll_targets = []
        self.votes = {}

    def current_polls(self):
        return self.polls_by_user.setdefault(self.user_id, [])

    def poll_snapshot(self, target_id=None):
        records = list(self.current_polls())
        if target_id is not None:
            records += self.target_polls_by_user.get(self.user_id, [])
            records = [p for p in records if p["id"] == target_id]
        else:
            records = records[:100]
        result = json.loads(json.dumps(records))
        for poll in result:
            if poll["id"] in self.votes:
                for option in poll["options"]:
                    voters = self.votes[poll["id"]].get(option["id"], set())
                    option["vote_count"] = len(voters)
                    option["voted_by_me"] = self.user_id in voters
        return {"polls": result}

    def handle(self, route):
        request = route.request
        url = urlparse(request.url)
        name = url.path.split("/")[-1]
        names = {"plan_polls_snapshot", "plan_poll_target_snapshot", "create_plan_poll", "set_plan_poll_votes", "convert_plan_poll", "delete_plan_poll"}
        if name == "delete_social_plan" and request.method == "POST":
            plan_id = (request.post_data_json or {}).get("plan_id")
            for records in self.polls_by_user.values():
                for poll in records:
                    if poll["plan_id"] == plan_id:
                        poll["plan_id"] = None
        if not url.path.startswith("/rest/v1/rpc/") or name not in names:
            return super().handle(route)
        if request.method == "OPTIONS":
            route.fulfill(status=200, headers=social.HEADERS, body="{}")
            return
        body = request.post_data_json or {}
        self.calls.append({"path": url.path, "query": parse_qs(url.query), "method": request.method, "body": body})

        def respond(value=None, status=200):
            route.fulfill(status=status, headers=social.HEADERS, body=json.dumps(value))

        def fail(code):
            respond({"code": code, "message": "Poll unavailable"}, 404 if code == "PGRST202" else 403)

        if name == "plan_polls_snapshot":
            if self.poll_error:
                fail(self.poll_error)
            elif self.hold_poll_snapshot:
                self.held_poll_snapshots.append((route, self.poll_snapshot()))
                self.hold_poll_snapshot = False
            else:
                respond(self.poll_snapshot())
            return
        if name == "plan_poll_target_snapshot":
            if self.poll_target_error:
                fail(self.poll_target_error)
            elif self.hold_poll_target:
                self.held_poll_targets.append((route, self.poll_snapshot(body["poll_id"])))
                self.hold_poll_target = False
            else:
                respond(self.poll_snapshot(body["poll_id"]))
            return
        if self.poll_mutation_error:
            fail(self.poll_mutation_error)
            return
        if name == "create_plan_poll":
            self.poll_serial += 1
            poll_id = f"eeeeeeee-eeee-4eee-8eee-{self.poll_serial + 100:012d}"
            poll = {"id": poll_id, "owner": self.profile.copy(), "title": body["poll_title"],
                    "place": body["poll_place"], "kind": body["poll_kind"], "created_at": accounts.NOW,
                    "invitees": [self.other_profiles[p].copy() for p in body["invitee_ids"]],
                    "options": [{"id": f"ffffffff-ffff-4fff-8fff-{self.poll_serial * 10 + i:012d}",
                                 "starts_at": value, "vote_count": 0, "voted_by_me": False}
                                for i, value in enumerate(body["option_times"])],
                    "closed_at": None, "plan_id": None}
            self.current_polls().insert(0, poll)
            respond(poll_id)
            return
        poll = next(p for p in self.current_polls() + self.target_polls_by_user.get(self.user_id, []) if p["id"] == body["poll_id"])
        if name == "set_plan_poll_votes":
            if self.hold_poll_vote:
                self.held_poll_votes.append((route, self.user_id, body.copy()))
                self.hold_poll_vote = False
                return
            ballots = self.votes.setdefault(poll["id"], {o["id"]: set() for o in poll["options"]})
            for option_id, voters in ballots.items():
                voters.discard(self.user_id)
                if option_id in body["option_ids"]:
                    voters.add(self.user_id)
            respond()
        elif name == "convert_plan_poll":
            if not poll["plan_id"]:
                self.plan_serial += 1
                poll["plan_id"] = f"poll-plan-{self.plan_serial}"
                poll["closed_at"] = datetime.now(timezone.utc).isoformat()
                option = next(o for o in poll["options"] if o["id"] == body["option_id"])
                self.current_social()["plans"].insert(0, {
                    "id": poll["plan_id"], "owner": poll["owner"].copy(), "title": poll["title"],
                    "place": poll["place"], "kind": poll["kind"], "starts_at": option["starts_at"],
                    "created_at": accounts.NOW, "invitees": json.loads(json.dumps(poll["invitees"])),
                    "attendees": [poll["owner"].copy()],
                })
            respond(poll["plan_id"])
        elif name == "delete_plan_poll":
            self.polls_by_user[self.user_id] = [p for p in self.current_polls() if p["id"] != poll["id"]]
            self.target_polls_by_user[self.user_id] = [p for p in self.target_polls_by_user.get(self.user_id, []) if p["id"] != poll["id"]]
            respond()


class PollBrowserTests(unittest.TestCase):
    setUpClass = accounts.AccountIntegrationTests.__dict__["setUpClass"]
    tearDownClass = accounts.AccountIntegrationTests.__dict__["tearDownClass"]
    tearDown = accounts.AccountIntegrationTests.tearDown
    visit = accounts.AccountIntegrationTests.visit
    account = accounts.AccountIntegrationTests.account
    open_account = accounts.AccountIntegrationTests.open_account
    sign_in = accounts.AccountIntegrationTests.sign_in
    submit_sign_in = accounts.AccountIntegrationTests.submit_sign_in
    close_account = accounts.AccountIntegrationTests.close_account
    sign_in_feed = social.SocialBrowserTests.sign_in_feed
    rpc_body = social.SocialBrowserTests.rpc_body
    add_friend = circles.CircleBrowserTests.add_friend
    seed_circle = circles.CircleBrowserTests.seed_circle
    refresh_relationships = circles.CircleBrowserTests.refresh_relationships

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 1050}, reduced_motion="reduce")
        self.service = MockPollService()
        self.errors = []
        self.unexpected_remote_hosts = []
        def local_only(route):
            if urlparse(route.request.url).hostname in {urlparse(accounts.DEMO_URL).hostname, urlparse(accounts.ACCOUNT_URL).hostname}:
                route.continue_()
            else:
                self.unexpected_remote_hosts.append(urlparse(route.request.url).hostname)
                route.abort()
        self.context.route("**/*", local_only)
        self.context.route(f"**{accounts.MOCK_HOST}/**", self.service.handle)
        self.page = self.context.new_page()
        self.page.set_default_timeout(9000)
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def navigate(self, tab):
        nav = "Mobile navigation" if self.page.viewport_size["width"] <= 640 else "Main navigation"
        self.page.get_by_role("navigation", name=nav, exact=True).get_by_role("button", name=re.compile(rf"^{tab}(?:$|\s)")).click()

    def sign_in_plans(self):
        self.sign_in_feed()
        self.navigate("Plans")
        expect(self.page.get_by_role("button", name="Find a time", exact=True)).to_be_visible()

    def create_dialog(self):
        self.page.get_by_role("button", name=re.compile(r"^(Find a time|Continue poll)$")).click()
        dialog = self.page.get_by_role("dialog", name="Create availability poll", exact=True)
        expect(dialog).to_be_visible()
        return dialog

    def audience(self, dialog):
        dialog.get_by_role("button", name=re.compile(r"^Audience:")).click()
        audience = self.page.get_by_role("dialog", name="Choose poll audience", exact=True)
        expect(audience).to_be_visible()
        return audience

    def fill_poll(self, dialog, title="Coffee this weekend?", count=2):
        dialog.get_by_label("Poll title", exact=True).fill(title)
        dialog.get_by_label("Meeting place", exact=True).fill("Our chosen café")
        for index in range(count):
            if index >= 2:
                dialog.get_by_role("button", name="Add time option", exact=True).click()
            day = (datetime.now(timezone.utc) + timedelta(days=7 + index)).strftime("%Y-%m-%d")
            dialog.get_by_label(f"Option {index + 1} date", exact=True).fill(day)
            dialog.get_by_label(f"Option {index + 1} time (Philippines)", exact=True).fill("15:00")

    def publish(self, dialog, title):
        dialog.get_by_role("button", name="Publish poll", exact=True).click()
        expect(dialog).to_have_count(0)
        card = self.card(title)
        expect(card).to_be_visible()
        return card

    def card(self, title):
        return self.page.get_by_role("article", name=f"Poll: {title}", exact=True)

    def seed_poll(self, title="Weekend catch-up?", owner=None, old=False, poll_id=POLL_ID):
        poll = {"id": poll_id, "owner": (owner or self.service.profile).copy(), "title": title,
                "place": "Our chosen café", "kind": "coffee", "created_at": accounts.NOW,
                "invitees": [self.service.other_profiles[accounts.FRIEND_ID].copy()] if owner is None else [self.service.profile.copy()],
                "options": [{"id": id, "starts_at": (datetime.now(timezone.utc) + timedelta(days=7 + i)).isoformat(), "vote_count": 0, "voted_by_me": False}
                            for i, id in enumerate([OPTION_A, OPTION_B])],
                "closed_at": None, "plan_id": None}
        records = self.service.target_polls_by_user if old else self.service.polls_by_user
        records.setdefault(self.service.user_id, []).append(poll)
        return poll

    def refresh_polls(self):
        with self.page.expect_response(f"**{accounts.MOCK_HOST}/rest/v1/rpc/plan_polls_snapshot"):
            self.page.evaluate("window.dispatchEvent(new Event('focus'))")

    def held(self, queue):
        deadline = time.monotonic() + 5
        while not queue and time.monotonic() < deadline:
            self.page.wait_for_timeout(10)
        self.assertTrue(queue, "Expected intercepted request was not queued")
        return queue.pop()

    def screenshot(self, name):
        Path("test-results").mkdir(exist_ok=True)
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        self.page.screenshot(path=f"test-results/polls-{name}.png")

    def test_01_private_creation_requires_distinct_options_and_never_caches_poll_content(self):
        self.sign_in_plans()
        dialog = self.create_dialog()
        expect(dialog.get_by_role("button", name="Audience: Only me", exact=True)).to_be_visible()
        self.fill_poll(dialog, count=5)
        expect(dialog.get_by_role("button", name="Add time option", exact=True)).to_be_disabled()
        dialog.get_by_role("button", name="Remove option 5", exact=True).click()
        dialog.get_by_role("button", name="Remove option 4", exact=True).click()
        dialog.get_by_role("button", name="Remove option 3", exact=True).click()
        first = dialog.get_by_label("Option 1 date", exact=True).input_value()
        dialog.get_by_label("Option 2 date", exact=True).fill(first)
        dialog.get_by_role("button", name="Publish poll", exact=True).click()
        expect(dialog.get_by_role("alert")).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/create_plan_poll", "POST"), [])
        dialog.get_by_label("Option 2 date", exact=True).fill((datetime.now(timezone.utc) + timedelta(days=8)).strftime("%Y-%m-%d"))
        self.publish(dialog, "Coffee this weekend?")
        body = self.rpc_body("create_plan_poll")
        self.assertEqual(body["invitee_ids"], [])
        self.assertEqual(len(body["option_times"]), 2)
        self.assertEqual(body["poll_title"], "Coffee this weekend?")
        self.assertTrue(all(value.endswith("+08:00") or value.endswith("Z") for value in body["option_times"]))
        self.assertFalse(self.page.evaluate("Object.values(localStorage).some(v => v.includes('Coffee this weekend?') || v.includes('Our chosen café'))"))

    def test_02_circles_snapshot_only_selected_friends_and_closed_picker_prunes_removed_people(self):
        circle = self.seed_circle()
        self.sign_in_plans()
        dialog = self.create_dialog()
        self.fill_poll(dialog, "The original Pamilya")
        audience = self.audience(dialog)
        audience.get_by_role("button", name="Use Pamilya", exact=True).click()
        audience.get_by_role("button", name="Done choosing audience", exact=True).click()
        self.add_friend()
        circle["member_ids"].append(accounts.INCOMING_ID)
        self.refresh_relationships()
        expect(dialog.get_by_role("button", name="Audience: 1 friend", exact=True)).to_be_visible()
        self.publish(dialog, "The original Pamilya")
        self.assertEqual(self.rpc_body("create_plan_poll")["invitee_ids"], [accounts.FRIEND_ID])
        dialog = self.create_dialog()
        self.fill_poll(dialog, "A smaller current audience")
        audience = self.audience(dialog)
        audience.get_by_role("button", name="All current friends", exact=True).click()
        audience.get_by_role("button", name="Done choosing audience", exact=True).click()
        self.service.friendships = [f for f in self.service.friendships if accounts.FRIEND_ID not in (f["user_a"], f["user_b"])]
        self.refresh_relationships()
        expect(dialog.get_by_role("button", name="Audience: 1 friend", exact=True)).to_be_visible()
        self.publish(dialog, "A smaller current audience")
        self.assertEqual(self.rpc_body("create_plan_poll")["invitee_ids"], [accounts.INCOMING_ID])

    def test_03_multi_option_votes_persist_and_can_be_cleared(self):
        self.seed_poll()
        self.sign_in_plans()
        card = self.card("Weekend catch-up?")
        card.get_by_role("checkbox").nth(0).check()
        card.get_by_role("checkbox").nth(1).check()
        card.get_by_role("button", name="Save availability", exact=True).click()
        expect(card.get_by_text("Your availability was saved.", exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("set_plan_poll_votes"), {"poll_id": POLL_ID, "option_ids": [OPTION_A, OPTION_B]})
        self.page.reload()
        card = self.card("Weekend catch-up?")
        expect(card.get_by_role("checkbox").nth(0)).to_be_checked()
        expect(card.get_by_role("checkbox").nth(1)).to_be_checked()
        card.get_by_role("checkbox").nth(0).uncheck()
        card.get_by_role("checkbox").nth(1).uncheck()
        card.get_by_role("button", name="Save availability", exact=True).click()
        expect(card.get_by_text("Your availability was saved.", exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("set_plan_poll_votes")["option_ids"], [])
        self.page.reload()
        expect(self.card("Weekend catch-up?").locator("input[type=checkbox]:checked")).to_have_count(0)

    def test_04_invited_friend_can_vote_but_has_no_organizer_controls(self):
        poll = self.seed_poll(owner=self.service.other_profiles[accounts.FRIEND_ID])
        self.sign_in_plans()
        card = self.card(poll["title"])
        expect(card.get_by_role("button", name="Choose a time", exact=True)).to_have_count(0)
        expect(card.get_by_role("button", name=re.compile(r"^Delete poll:"))).to_have_count(0)
        card.get_by_role("checkbox").first.check()
        card.get_by_role("button", name="Save availability", exact=True).click()
        expect(card.get_by_text("Your availability was saved.", exact=True)).to_be_visible()
        expect(card.get_by_role("checkbox").first).to_be_checked()
        self.assertEqual(self.rpc_body("set_plan_poll_votes"), {"poll_id": POLL_ID, "option_ids": [OPTION_A]})

    def test_05_organizer_conversion_uses_exact_option_and_original_audience_without_rsvp(self):
        poll = self.seed_poll()
        self.sign_in_plans()
        self.add_friend()
        self.refresh_relationships()
        card = self.card(poll["title"])
        card.get_by_role("button", name="Choose a time", exact=True).click()
        dialog = self.page.get_by_role("dialog", name="Create plan from poll", exact=True)
        dialog.get_by_role("radio").nth(1).check()
        dialog.get_by_role("button", name="Close dialog", exact=True).click()
        self.assertEqual(self.service.matching("/rest/v1/rpc/convert_plan_poll", "POST"), [])
        card.get_by_role("button", name="Choose a time", exact=True).click()
        dialog.get_by_role("radio").nth(1).check()
        dialog.get_by_role("button", name="Create plan", exact=True).click()
        expect(dialog).to_have_count(0)
        self.assertEqual(self.rpc_body("convert_plan_poll"), {"poll_id": POLL_ID, "option_id": OPTION_B})
        created = self.service.current_social()["plans"][0]
        self.assertEqual(created["starts_at"], poll["options"][1]["starts_at"])
        self.assertEqual([p["id"] for p in created["invitees"]], [accounts.FRIEND_ID])
        self.assertEqual([p["id"] for p in created["attendees"]], [accounts.USER_ID])
        expect(card.get_by_role("button", name="Choose a time", exact=True)).to_have_count(0)
        expect(card.get_by_role("button", name="Save availability", exact=True)).to_have_count(0)
        expect(self.page.locator(f"#activity-plan-{created['id']}")).to_be_visible()
        self.service.current_social()["plans"] = [p for p in self.service.current_social()["plans"] if p["id"] != created["id"]]
        poll["plan_id"] = None
        self.refresh_polls()
        expect(card.get_by_role("button", name="Choose a time", exact=True)).to_have_count(0)
        self.assertIsNotNone(poll["closed_at"])

    def test_06_inbox_opens_exact_poll_beyond_latest100_and_revoked_target_disappears(self):
        for number in range(100):
            self.seed_poll(f"Recent poll {number}", poll_id=f"eeeeeeee-eeee-4eee-8eee-{number + 1000:012d}")
        old = self.seed_poll("An older availability poll", owner=self.service.other_profiles[accounts.FRIEND_ID], old=True, poll_id=OLD_POLL_ID)
        self.service.add_activity("poll_invite", poll_id=OLD_POLL_ID, poll_title=old["title"])
        self.sign_in_feed()
        expect(self.card(old["title"])).to_have_count(0)
        self.page.get_by_role("button", name="Open notifications", exact=True).click()
        inbox = self.page.get_by_role("dialog", name="Activity inbox", exact=True)
        inbox.get_by_role("button", name=re.compile(r"^Unread: Test Bea .*An older availability poll")).click()
        card = self.card(old["title"])
        expect(card).to_be_visible()
        expect(card).to_be_focused()
        self.assertEqual(self.rpc_body("plan_poll_target_snapshot"), {"poll_id": OLD_POLL_ID})
        self.service.target_polls_by_user[self.service.user_id] = []
        self.refresh_polls()
        expect(card).to_have_count(0)
        expect(self.page.get_by_text(re.compile(r"no longer available|no longer have access", re.I))).to_be_visible()

    def test_07_account_switch_discards_drafts_and_late_old_snapshot(self):
        self.seed_poll("Maria private old poll")
        self.sign_in_plans()
        dialog = self.create_dialog()
        self.fill_poll(dialog, "Maria unsent private poll")
        dialog.get_by_role("button", name="Close dialog", exact=True).click()
        self.service.hold_poll_snapshot = True
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        pending, snapshot = self.held(self.service.held_poll_snapshots)
        self.open_account().get_by_role("button", name="Sign out", exact=True).click()
        expect(self.account().get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        self.service.switch_user(accounts.SECOND_USER_ID, "Luna Other", "luna_other", "luna@example.test")
        self.submit_sign_in(self.account())
        self.close_account()
        pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(snapshot))
        self.navigate("Plans")
        expect(self.card("Maria private old poll")).to_have_count(0)
        dialog = self.create_dialog()
        expect(dialog.get_by_label("Poll title", exact=True)).to_have_value("")
        expect(dialog.get_by_role("button", name="Audience: Only me", exact=True)).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/create_plan_poll", "POST"), [])

    def test_08_failed_publish_keeps_draft_and_missing_polls_do_not_hide_existing_plans(self):
        self.sign_in_plans()
        dialog = self.create_dialog()
        self.fill_poll(dialog, "Keep my failed poll draft")
        self.service.poll_mutation_error = "42501"
        dialog.get_by_role("button", name="Publish poll", exact=True).click()
        expect(dialog.get_by_role("alert")).to_be_visible()
        expect(dialog.get_by_label("Poll title", exact=True)).to_have_value("Keep my failed poll draft")
        self.assertEqual(self.service.current_polls(), [])
        dialog.get_by_role("button", name="Close dialog", exact=True).click()
        self.service.poll_mutation_error = None
        self.refresh_polls()
        dialog = self.create_dialog()
        expect(dialog.get_by_label("Poll title", exact=True)).to_have_value("Keep my failed poll draft")
        self.publish(dialog, "Keep my failed poll draft")
        self.service.poll_error = "PGRST202"
        self.refresh_polls()
        expect(self.page.get_by_role("heading", name="Real lunch invitation", exact=True)).to_be_visible()
        expect(self.page.get_by_role("button", name="Make a plan", exact=True)).to_be_enabled()
        expect(self.card("Keep my failed poll draft")).to_have_count(0)

    def test_09_delete_confirmation_preserves_converted_plan_and_can_be_cancelled(self):
        poll = self.seed_poll()
        poll["closed_at"] = accounts.NOW
        poll["plan_id"] = "an-existing-converted-plan"
        self.service.current_social()["plans"].insert(0, {
            "id": poll["plan_id"], "owner": poll["owner"].copy(), "title": poll["title"],
            "place": poll["place"], "kind": poll["kind"], "starts_at": poll["options"][0]["starts_at"],
            "created_at": accounts.NOW, "invitees": json.loads(json.dumps(poll["invitees"])),
            "attendees": [poll["owner"].copy()],
        })
        self.sign_in_plans()
        card = self.card(poll["title"])
        card.get_by_role("button", name=f"Delete poll: {poll['title']}", exact=True).click()
        dialog = self.page.get_by_role("dialog", name="Delete this poll?", exact=True)
        dialog.get_by_role("button", name="Keep poll", exact=True).click()
        expect(card).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/delete_plan_poll", "POST"), [])
        card.get_by_role("button", name=f"Delete poll: {poll['title']}", exact=True).click()
        dialog.get_by_role("button", name="Yes, delete poll", exact=True).click()
        expect(dialog).to_have_count(0)
        expect(card).to_have_count(0)
        self.assertEqual(self.rpc_body("delete_plan_poll"), {"poll_id": POLL_ID})
        expect(self.page.locator(f"#activity-plan-{poll['plan_id']}")).to_be_visible()

    def test_10_mobile_both_themes_compose_vote_audience_and_keyboard_fit(self):
        poll = self.seed_poll()
        self.sign_in_plans()
        for dark in (False, True):
            toggle = self.page.get_by_role("switch", name="Dark mode", exact=True)
            if (toggle.get_attribute("aria-checked") == "true") != dark:
                toggle.click()
            for width in (375, 320):
                self.page.set_viewport_size({"width": width, "height": 812})
                card = self.card(poll["title"])
                first = card.get_by_role("checkbox").first
                first.set_checked(not first.is_checked())
                card.get_by_role("button", name="Save availability", exact=True).click()
                expect(card.get_by_text("Your availability was saved.", exact=True)).to_be_visible()
                self.screenshot(f"cards-{'dark' if dark else 'light'}-{width}")
                dialog = self.create_dialog()
                self.fill_poll(dialog, "An unsent mobile poll")
                dialog.get_by_role("button", name="Close dialog", exact=True).focus()
                dialog.evaluate("element => { element.scrollTop = 0; }")
                self.screenshot(f"create-{'dark' if dark else 'light'}-{width}")
                audience = self.audience(dialog)
                audience.get_by_role("button", name="All current friends", exact=True).click()
                done = audience.get_by_role("button", name="Done choosing audience", exact=True)
                done.focus()
                self.page.keyboard.press("Tab")
                expect(audience.get_by_role("button", name="Close dialog", exact=True)).to_be_focused()
                self.page.keyboard.press("Shift+Tab")
                expect(done).to_be_focused()
                self.screenshot(f"audience-{'dark' if dark else 'light'}-{width}")
                self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth"), width)
                self.assertLessEqual(audience.bounding_box()["width"], width)
                self.page.keyboard.press("Escape")
                expect(dialog).to_be_visible()
                expect(dialog.get_by_role("button", name="Audience: 1 friend", exact=True)).to_be_focused()
                self.page.keyboard.press("Escape")
                expect(self.page.get_by_role("dialog")).to_have_count(0)

    def test_11_late_vote_completion_cannot_update_another_accounts_poll_state(self):
        self.seed_poll("Maria in-flight availability")
        self.sign_in_plans()
        card = self.card("Maria in-flight availability")
        card.get_by_role("checkbox").first.check()
        self.service.hold_poll_vote = True
        card.get_by_role("button", name="Save availability", exact=True).click()
        pending, owner, body = self.held(self.service.held_poll_votes)
        self.assertEqual(owner, accounts.USER_ID)
        self.assertEqual(body, {"poll_id": POLL_ID, "option_ids": [OPTION_A]})
        self.open_account().get_by_role("button", name="Sign out", exact=True).click()
        expect(self.account().get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        self.service.switch_user(accounts.SECOND_USER_ID, "Luna Other", "luna_other", "luna@example.test")
        self.submit_sign_in(self.account())
        self.close_account()
        pending.fulfill(status=200, headers=social.HEADERS, body="null")
        self.navigate("Plans")
        expect(self.card("Maria in-flight availability")).to_have_count(0)
        expect(self.page.get_by_text("Your availability was saved.", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("button", name="Find a time", exact=True)).to_be_enabled()
        expect(self.create_dialog().get_by_label("Poll title", exact=True)).to_have_value("")

    def test_12_opened_poll_is_hidden_when_later_list_refresh_fails(self):
        old = self.seed_poll("Previously opened private poll", owner=self.service.other_profiles[accounts.FRIEND_ID], old=True, poll_id=OLD_POLL_ID)
        self.service.add_activity("poll_invite", poll_id=OLD_POLL_ID, poll_title=old["title"])
        self.sign_in_feed()
        self.page.get_by_role("button", name="Open notifications", exact=True).click()
        self.page.get_by_role("dialog", name="Activity inbox", exact=True).get_by_role("button", name=re.compile(r"^Unread: Test Bea .*Previously opened private poll")).click()
        card = self.card(old["title"])
        expect(card).to_be_visible()
        self.service.poll_error = "42501"
        self.refresh_polls()
        expect(card).to_have_count(0)
        expect(self.page.get_by_role("main").get_by_role("alert").first).to_contain_text(re.compile(r"no longer available|access has changed", re.I))
        self.service.poll_error = None
        self.refresh_polls()
        expect(card).to_have_count(0)

    def test_13_delayed_target_cannot_restore_private_contents_after_list_refresh_failure(self):
        old = self.seed_poll("A delayed private poll", owner=self.service.other_profiles[accounts.FRIEND_ID], old=True, poll_id=OLD_POLL_ID)
        self.service.add_activity("poll_invite", poll_id=OLD_POLL_ID, poll_title=old["title"])
        self.sign_in_feed()
        self.service.hold_poll_target = True
        self.page.get_by_role("button", name="Open notifications", exact=True).click()
        self.page.get_by_role("dialog", name="Activity inbox", exact=True).get_by_role("button", name=re.compile(r"^Unread: Test Bea .*A delayed private poll")).click()
        pending, old_snapshot = self.held(self.service.held_poll_targets)
        self.service.poll_error = "42501"
        self.refresh_polls()
        expect(self.page.get_by_role("main").get_by_role("alert").first).to_be_visible()
        with self.page.expect_response(f"**{accounts.MOCK_HOST}/rest/v1/rpc/plan_poll_target_snapshot") as completion:
            pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(old_snapshot))
        self.assertEqual(completion.value.json(), old_snapshot)
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        expect(self.card(old["title"])).to_have_count(0)
        self.service.poll_error = None
        self.refresh_polls()
        expect(self.card(old["title"])).to_have_count(0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
