"""Private plan-conversation browser checks against intercepted fictional HTTP.

Use the local servers described in accounts.py. Database authorization and
audience revocation are tested separately with PostgreSQL. No hosted writes,
messages, email, push notifications, or real account credentials are used here.
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
import social

OWN_PLAN = "99999999-9999-4999-8999-999999999998"
OLD_PLAN = "99999999-9999-4999-8999-999999999997"


class MockConversationService(social.MockSocialService):
    """UI transport fixture; this is not a database authorization implementation."""
    def __init__(self):
        super().__init__()
        self.messages_by_plan = {}
        self.read_by_user = {}
        self.message_serial = 0
        self.nonces = {}
        self.summary_error = None
        self.conversation_error = None
        self.send_error = None
        self.delete_error = None
        self.mark_error = None
        self.fail_after_send_once = False
        self.summary_error_after_send = None
        self.revoked_plan_ids = set()
        self.hidden_message_ids = set()
        self.hold_conversation = False
        self.held_conversations = []
        self.hold_summary = False
        self.held_summaries = []
        self.hold_send = False
        self.held_sends = []
        self.hold_mark = False
        self.held_marks = []

    def find_plan(self, plan_id):
        if plan_id in self.revoked_plan_ids:
            return None
        plans = self.current_social()["plans"] + self.target_plans_by_user.get(self.user_id, [])
        return next((plan for plan in plans if plan["id"] == plan_id), None)

    def read_ids(self, owner=None):
        return self.read_by_user.setdefault(owner or self.user_id, set())

    def messages(self, plan_id):
        return [message for message in self.messages_by_plan.get(plan_id, []) if message["id"] not in self.hidden_message_ids]

    def unread(self, plan_id):
        return sum(message["author"]["id"] != self.user_id and message["id"] not in self.read_ids()
                   for message in self.messages(plan_id))

    def summary(self):
        plans = self.current_social()["plans"] + self.target_plans_by_user.get(self.user_id, [])
        return {"conversations": [{"plan_id": plan["id"], "unread_count": self.unread(plan["id"])}
                                  for plan in plans if plan["id"] not in self.revoked_plan_ids]}

    def snapshot(self, plan_id, before_created_at=None, before_id=None):
        records = sorted(self.messages(plan_id), key=lambda message: (message["created_at"], message["id"]))
        if before_created_at is not None and before_id is not None:
            records = [message for message in records if (message["created_at"], message["id"]) < (before_created_at, before_id)]
        page = records[-50:]
        more = len(records) > len(page)
        cursor = {"created_at": page[0]["created_at"], "id": page[0]["id"]} if more else None
        return json.loads(json.dumps({"plan_id": plan_id, "messages": page,
                                      "unread_count": self.unread(plan_id), "has_more": more, "next_before": cursor}))

    def add_message(self, body, plan_id=social.PLAN_ID, author_id=accounts.FRIEND_ID, notify=False):
        self.message_serial += 1
        author = self.profile if author_id == self.user_id else self.other_profiles[author_id]
        message = {"id": f"cccccccc-cccc-4ccc-8ccc-{self.message_serial:012d}",
                   "author": author.copy(), "body": body,
                   "created_at": (datetime.fromisoformat(accounts.NOW.replace("Z", "+00:00")) + timedelta(seconds=self.message_serial)).isoformat()}
        self.messages_by_plan.setdefault(plan_id, []).append(message)
        if notify:
            plan = self.find_plan(plan_id)
            self.inbox_by_user[self.user_id] = [item for item in self.current_inbox()
                                                if not (item["kind"] == "plan_message" and item["plan_id"] == plan_id)]
            self.add_activity("plan_message", actor_id=author_id, plan_id=plan_id,
                              plan_title=plan["title"], message_id=message["id"], plan_starts_at=plan["starts_at"])
        return message

    def commit_send(self, owner, profile, body):
        key = (owner, body["plan_id"], body["client_nonce"])
        if key in self.nonces:
            return self.nonces[key]
        self.message_serial += 1
        message = {"id": f"cccccccc-cccc-4ccc-8ccc-{self.message_serial:012d}",
                   "author": profile.copy(), "body": body["body_text"],
                   "created_at": datetime.now(timezone.utc).isoformat()}
        self.messages_by_plan.setdefault(body["plan_id"], []).append(message)
        self.nonces[key] = message["id"]
        return message["id"]

    def apply_read(self, owner, body):
        self.read_ids(owner).update(body["message_ids"])
        for item in self.inbox_by_user.get(owner, []):
            if item["kind"] == "plan_message" and item["plan_id"] == body["plan_id"] and item.get("message_id") in body["message_ids"]:
                item["read_at"] = item["read_at"] or accounts.NOW

    def handle(self, route):
        request = route.request
        url = urlparse(request.url)
        name = url.path.split("/")[-1]
        if request.method == "POST" and name == "delete_social_plan":
            plan_id = (request.post_data_json or {}).get("plan_id")
            self.messages_by_plan.pop(plan_id, None)
            for owner, items in self.inbox_by_user.items():
                self.inbox_by_user[owner] = [item for item in items if not (item["kind"] == "plan_message" and item["plan_id"] == plan_id)]
        names = {"plan_conversations_snapshot", "plan_conversation_snapshot", "send_plan_message", "delete_plan_message", "mark_plan_messages_read"}
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
            respond({"code": code, "message": "Conversation unavailable"}, 404 if code == "PGRST202" else 403)

        if name == "plan_conversations_snapshot":
            if self.summary_error:
                fail(self.summary_error)
            elif self.hold_summary:
                self.held_summaries.append((route, self.summary()))
                self.hold_summary = False
            else:
                respond(self.summary())
        elif name == "plan_conversation_snapshot":
            if self.conversation_error or self.find_plan(body["plan_id"]) is None:
                fail(self.conversation_error or "42501")
            elif self.hold_conversation:
                self.held_conversations.append((route, self.snapshot(body["plan_id"], body.get("before_created_at"), body.get("before_id"))))
                self.hold_conversation = False
            else:
                respond(self.snapshot(body["plan_id"], body.get("before_created_at"), body.get("before_id")))
        elif name == "send_plan_message":
            if self.send_error:
                fail(self.send_error)
            elif self.hold_send:
                self.held_sends.append((route, self.user_id, self.profile.copy(), body.copy()))
                self.hold_send = False
            else:
                message_id = self.commit_send(self.user_id, self.profile, body)
                if self.summary_error_after_send:
                    self.summary_error = self.summary_error_after_send
                    self.summary_error_after_send = None
                if self.fail_after_send_once:
                    self.fail_after_send_once = False
                    fail("P0001")
                else:
                    respond(message_id)
        elif name == "delete_plan_message":
            if self.delete_error:
                fail(self.delete_error)
            else:
                for plan_id, records in self.messages_by_plan.items():
                    self.messages_by_plan[plan_id] = [message for message in records if message["id"] != body["message_id"]]
                for owner, items in self.inbox_by_user.items():
                    self.inbox_by_user[owner] = [item for item in items if item.get("message_id") != body["message_id"]]
                respond()
        elif name == "mark_plan_messages_read":
            if self.mark_error:
                fail(self.mark_error)
            elif self.hold_mark:
                self.held_marks.append((route, self.user_id, body.copy()))
                self.hold_mark = False
            else:
                self.apply_read(self.user_id, body)
                respond()


class ConversationBrowserTests(unittest.TestCase):
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

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 1050}, reduced_motion="reduce")
        self.service = MockConversationService()
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
        expect(self.card()).to_be_visible()

    def card(self, plan_id=social.PLAN_ID):
        return self.page.locator(f"#activity-plan-{plan_id}")

    def conversation(self, plan_id=social.PLAN_ID):
        plan = self.service.find_plan(plan_id)
        self.card(plan_id).get_by_role("button", name=f"Open conversation for {plan['title']}", exact=True).click()
        dialog = self.dialog()
        expect(dialog).to_be_visible()
        return dialog

    def dialog(self):
        return self.page.get_by_role("dialog", name="Conversation", exact=True)

    def close_conversation(self):
        dialog = self.dialog()
        if dialog.count():
            dialog.get_by_role("button", name="Close dialog", exact=True).click()

    def send(self, dialog, body):
        dialog.get_by_role("textbox", name="Message", exact=True).fill(body)
        dialog.get_by_role("button", name="Send message", exact=True).click()
        expect(dialog.get_by_role("textbox", name="Message", exact=True)).to_have_value("")
        expect(dialog.get_by_text(body.strip(), exact=True)).to_be_visible()

    def refresh(self, dialog):
        dialog.get_by_role("button", name="Refresh conversation", exact=True).click()

    def held(self, queue):
        deadline = time.monotonic() + 5
        while not queue and time.monotonic() < deadline:
            self.page.wait_for_timeout(10)
        self.assertTrue(queue, "Expected intercepted request was not queued")
        return queue.pop()

    def own_plan(self, plan_id=OWN_PLAN, title="Maria’s private plan"):
        plan = {"id": plan_id, "owner": self.service.profile.copy(), "title": title,
                "place": "Pamilya café", "starts_at": "2099-11-05T07:00:00+00:00", "kind": "coffee", "created_at": accounts.NOW,
                "invitees": [], "attendees": [self.service.profile.copy()]}
        self.service.current_social()["plans"].append(plan)
        return plan

    def switch_account_in_second_tab(self):
        second = self.context.new_page()
        second.set_default_timeout(9000)
        second.on("pageerror", lambda error: self.errors.append(str(error)))
        second.goto(accounts.ACCOUNT_URL)
        expect(second.get_by_role("heading", name="Tara, Maria!", exact=True)).to_be_visible()
        second.get_by_role("button", name="Open your profile", exact=True).click()
        account = second.get_by_role("dialog", name="Your TARA account", exact=True)
        account.get_by_role("button", name="Sign out", exact=True).click()
        expect(self.dialog()).to_have_count(0)
        self.service.switch_user(accounts.SECOND_USER_ID, "Luna Other", "luna_other", "luna@example.test")
        account.get_by_label("Email address", exact=True).fill(self.service.email)
        account.get_by_label(re.compile(r"^Password")).fill(accounts.TEST_PASSWORD)
        account.get_by_role("button", name="Sign in to TARA", exact=True).click()
        expect(account.get_by_label("Display name", exact=True)).to_have_value("Luna Other")
        expect(self.page.get_by_role("button", name="Open your profile", exact=True).get_by_role("img", name="Luna Other", exact=True)).to_be_visible()
        return second

    def screenshot(self, name):
        Path("test-results").mkdir(exist_ok=True)
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        self.page.screenshot(path=f"test-results/conversations-{name}.png")

    def test_01_shared_messages_are_plain_text_and_send_only_plan_body_and_nonce(self):
        incoming = self.service.add_message("Meet near the main entrance.")
        self.sign_in_plans()
        expect(self.card().get_by_text("1", exact=True)).to_be_visible()
        dialog = self.conversation()
        expect(dialog.get_by_text(incoming["body"], exact=True)).to_be_visible()
        self.send(dialog, "I’m on my way, pamilya 🌻 <script>no HTML</script>")
        body = self.rpc_body("send_plan_message")
        self.assertEqual(set(body), {"plan_id", "body_text", "client_nonce"})
        self.assertEqual(body["plan_id"], social.PLAN_ID)
        self.assertRegex(body["client_nonce"], r"^[0-9a-f-]{36}$")
        self.assertEqual(dialog.locator("script").count(), 0)
        self.assertEqual(self.service.current_inbox(), [])
        self.assertFalse(self.page.evaluate("Object.values(localStorage).some(value => value.includes('I’m on my way'))"))

    def test_02_only_me_plan_supports_private_notes_without_self_notifications(self):
        self.own_plan()
        self.sign_in_plans()
        dialog = self.conversation(OWN_PLAN)
        self.assertEqual(dialog.locator(".social-recipient-picker").count(), 0)
        self.send(dialog, "Remember to bring the picnic mat.")
        self.assertEqual(self.rpc_body("send_plan_message")["plan_id"], OWN_PLAN)
        self.assertEqual(self.service.current_inbox(), [])
        self.assertEqual(self.service.unread(OWN_PLAN), 0)

    def test_03_draft_survives_close_and_empty_messages_cannot_send(self):
        self.sign_in_plans()
        dialog = self.conversation()
        textbox = dialog.get_by_role("textbox", name="Message", exact=True)
        textbox.fill("   ")
        expect(dialog.get_by_role("button", name="Send message", exact=True)).to_be_disabled()
        textbox.fill("A private unsent conversation draft")
        self.close_conversation()
        dialog = self.conversation()
        expect(dialog.get_by_role("textbox", name="Message", exact=True)).to_have_value("A private unsent conversation draft")
        expect(dialog.get_by_role("textbox", name="Message", exact=True)).to_have_attribute("maxlength", "1000")
        self.assertEqual(self.service.matching("/rest/v1/rpc/send_plan_message", "POST"), [])

    def test_04_failed_send_keeps_draft_and_retry_reuses_nonce_without_duplicate(self):
        self.sign_in_plans()
        dialog = self.conversation()
        self.service.fail_after_send_once = True
        dialog.get_by_role("textbox", name="Message", exact=True).fill("One safe retry, not two messages")
        dialog.get_by_role("button", name="Send message", exact=True).click()
        expect(dialog.get_by_role("alert").first).to_be_visible()
        # A rejected mutation hides stale conversation content. Recover first,
        # then verify that the draft and its safe retry nonce were retained.
        self.refresh(dialog)
        expect(dialog.get_by_role("list", name="Plan messages", exact=True).get_by_text("One safe retry, not two messages", exact=True)).to_be_visible()
        expect(dialog.get_by_role("textbox", name="Message", exact=True)).to_have_value("One safe retry, not two messages")
        dialog.get_by_role("button", name="Send message", exact=True).click()
        expect(dialog.get_by_role("textbox", name="Message", exact=True)).to_have_value("")
        calls = self.service.matching("/rest/v1/rpc/send_plan_message", "POST")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["body"]["client_nonce"], calls[1]["body"]["client_nonce"])
        self.assertEqual(sum(message["body"] == "One safe retry, not two messages" for message in self.service.messages(social.PLAN_ID)), 1)

    def test_05_older_pages_use_cursor_and_acknowledge_only_loaded_messages(self):
        records = [self.service.add_message(f"Older coordination message {index:02}") for index in range(65)]
        self.sign_in_plans()
        dialog = self.conversation()
        expect(dialog.get_by_text(records[15]["body"], exact=True)).to_be_visible()
        expect(dialog.get_by_text(records[0]["body"], exact=True)).to_have_count(0)
        self.page.wait_for_function("() => true")
        deadline = time.monotonic() + 5
        while len(self.service.read_ids()) < 50 and time.monotonic() < deadline:
            self.page.wait_for_timeout(10)
        self.assertSetEqual(self.service.read_ids(), {message["id"] for message in records[15:]})
        dialog.get_by_role("button", name="Load earlier messages", exact=True).click()
        expect(dialog.get_by_text(records[0]["body"], exact=True)).to_be_visible()
        before = self.rpc_body("plan_conversation_snapshot")
        self.assertEqual(before["before_created_at"], records[15]["created_at"])
        self.assertEqual(before["before_id"], records[15]["id"])
        deadline = time.monotonic() + 5
        while len(self.service.read_ids()) < 65 and time.monotonic() < deadline:
            self.page.wait_for_timeout(10)
        self.assertSetEqual(self.service.read_ids(), {message["id"] for message in records})
        expect(dialog.get_by_role("button", name="Load earlier messages", exact=True)).to_have_count(0)
        # A refresh must revalidate the older page too, so deleted or revoked
        # messages do not survive only because the reader paged backward.
        self.service.messages_by_plan[social.PLAN_ID] = records[1:]
        self.refresh(dialog)
        expect(dialog.get_by_text(records[0]["body"], exact=True)).to_have_count(0)
        expect(dialog.get_by_text(records[1]["body"], exact=True)).to_be_visible()

    def test_06_read_ack_does_not_mark_a_concurrently_arriving_new_message(self):
        first = self.service.add_message("The first message", notify=True)
        self.service.hold_mark = True
        self.sign_in_plans()
        dialog = self.conversation()
        pending, owner, body = self.held(self.service.held_marks)
        second = self.service.add_message("A newer message while the first was being read", notify=True)
        self.assertEqual(body, {"plan_id": social.PLAN_ID, "message_ids": [first["id"]]})
        self.service.apply_read(owner, body)
        pending.fulfill(status=200, headers=social.HEADERS, body="null")
        self.assertNotIn(second["id"], self.service.read_ids())
        self.assertIsNone(self.service.current_inbox()[0]["read_at"])
        self.refresh(dialog)
        expect(dialog.get_by_text(second["body"], exact=True)).to_be_visible()

    def test_07_only_own_messages_can_be_deleted_and_failed_delete_recovers_safely(self):
        other = self.service.add_message("Bea’s message stays")
        own = self.service.add_message("Delete my own message", author_id=accounts.USER_ID)
        self.sign_in_plans()
        dialog = self.conversation()
        expect(dialog.get_by_role("button", name=f"Delete message: {other['body']}", exact=True)).to_have_count(0)
        dialog.get_by_role("button", name=f"Delete message: {own['body']}", exact=True).click()
        expect(dialog.get_by_role("heading", name="Delete this message?", exact=True)).to_be_visible()
        self.service.delete_error = "42501"
        dialog.get_by_role("button", name="Yes, delete message", exact=True).click()
        expect(dialog.get_by_role("alert").first).to_be_visible()
        self.service.delete_error = None
        # The failed mutation hides stale messages; refresh before retrying.
        if dialog.get_by_role("button", name="Refresh conversation", exact=True).count():
            self.refresh(dialog)
        if dialog.get_by_role("button", name="Keep message", exact=True).count():
            dialog.get_by_role("button", name="Keep message", exact=True).click()
        dialog.get_by_role("button", name=f"Delete message: {own['body']}", exact=True).click()
        dialog.get_by_role("button", name="Yes, delete message", exact=True).click()
        expect(dialog.get_by_text(own["body"], exact=True)).to_have_count(0)
        expect(dialog.get_by_text(other["body"], exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("delete_plan_message"), {"message_id": own["id"]})

    def test_08_inbox_opens_an_older_plan_and_its_conversation_without_flooding_items(self):
        plan = self.own_plan(OLD_PLAN, "An older conversation plan")
        plan["owner"] = self.service.other_profiles[accounts.FRIEND_ID].copy()
        plan["invitees"] = [self.service.profile.copy()]
        plan["attendees"] = [plan["owner"].copy()]
        self.service.current_social()["plans"] = [item for item in self.service.current_social()["plans"] if item["id"] != OLD_PLAN]
        self.service.target_plans_by_user.setdefault(accounts.USER_ID, []).append(plan)
        self.service.add_message("First coordination update", plan_id=OLD_PLAN, notify=True)
        latest = self.service.add_message("Latest coordination update", plan_id=OLD_PLAN, notify=True)
        self.assertEqual(len([item for item in self.service.current_inbox() if item["kind"] == "plan_message"]), 1)
        self.sign_in_plans()
        self.page.get_by_role("button", name="Open notifications", exact=True).click()
        inbox = self.page.get_by_role("dialog", name="Activity inbox", exact=True)
        inbox.get_by_role("button").filter(has_text="An older conversation plan").click()
        dialog = self.dialog()
        expect(dialog).to_be_visible()
        expect(dialog.get_by_text(latest["body"], exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("activity_target_snapshot"), {"post_id": None, "plan_id": OLD_PLAN})
        self.assertEqual(self.rpc_body("plan_conversation_snapshot")["plan_id"], OLD_PLAN)
        self.assertNotIn("body", self.service.current_inbox()[0])

    def test_09_failed_refresh_hides_private_content_and_can_recover(self):
        incoming = self.service.add_message("A private conversation that must disappear on rejection")
        self.sign_in_plans()
        dialog = self.conversation()
        expect(dialog.get_by_text(incoming["body"], exact=True)).to_be_visible()
        self.service.conversation_error = "42501"
        self.refresh(dialog)
        expect(dialog.get_by_role("alert").first).to_be_visible()
        expect(dialog.get_by_text(incoming["body"], exact=True)).to_have_count(0)
        self.service.conversation_error = None
        self.refresh(dialog)
        expect(dialog.get_by_text(incoming["body"], exact=True)).to_be_visible()

    def test_10_late_read_cannot_restore_old_account_messages_or_draft(self):
        incoming = self.service.add_message("Maria’s private older conversation")
        self.sign_in_plans()
        dialog = self.conversation()
        dialog.get_by_role("textbox", name="Message", exact=True).fill("Maria’s unsent message draft")
        self.service.hold_conversation = True
        self.refresh(dialog)
        pending, old = self.held(self.service.held_conversations)
        second = self.switch_account_in_second_tab()
        pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(old))
        expect(self.page.get_by_text(incoming["body"], exact=True)).to_have_count(0)
        expect(self.page.get_by_text("Maria’s unsent message draft", exact=True)).to_have_count(0)
        expect(self.dialog()).to_have_count(0)
        second.close()

    def test_11_late_send_cannot_show_feedback_or_messages_on_new_account(self):
        self.sign_in_plans()
        dialog = self.conversation()
        dialog.get_by_role("textbox", name="Message", exact=True).fill("An in-flight Maria message")
        self.service.hold_send = True
        dialog.get_by_role("button", name="Send message", exact=True).click()
        pending, owner, profile, body = self.held(self.service.held_sends)
        second = self.switch_account_in_second_tab()
        saved = self.service.commit_send(owner, profile, body)
        pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(saved))
        expect(self.page.get_by_text("An in-flight Maria message", exact=True)).to_have_count(0)
        expect(self.dialog()).to_have_count(0)
        self.assertEqual(self.service.current_social()["plans"], [])
        second.close()

    def test_12_relationship_removal_closes_and_revokes_the_open_conversation(self):
        incoming = self.service.add_message("A revoked plan conversation")
        self.sign_in_plans()
        dialog = self.conversation()
        expect(dialog.get_by_text(incoming["body"], exact=True)).to_be_visible()
        self.service.hold_conversation = True
        self.refresh(dialog)
        pending, old = self.held(self.service.held_conversations)
        self.service.friendships = []
        self.service.current_social()["plans"] = []
        self.service.revoked_plan_ids.add(social.PLAN_ID)
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(self.dialog()).to_have_count(0)
        pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(old))
        expect(self.page.get_by_text(incoming["body"], exact=True)).to_have_count(0)
        expect(self.card()).to_have_count(0)

    def test_13_mobile_light_dark_message_controls_and_keyboard_focus_fit(self):
        self.service.add_message("Kita-kits! 🌻 Meeting near the main entrance.")
        self.service.add_message("My own mobile message", author_id=accounts.USER_ID)
        self.sign_in_plans()
        for dark in (False, True):
            toggle = self.page.get_by_role("switch", name="Dark mode", exact=True)
            if (toggle.get_attribute("aria-checked") == "true") != dark:
                toggle.click()
            for width in (375, 320):
                self.page.set_viewport_size({"width": width, "height": 812})
                opener = self.card().get_by_role("button", name="Open conversation for Real lunch invitation", exact=True)
                opener.click()
                dialog = self.dialog()
                expect(dialog).to_be_visible()
                expect(dialog.get_by_role("textbox", name="Message", exact=True)).to_be_visible()
                self.assertLessEqual(dialog.bounding_box()["width"], width)
                self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth"), width)
                dialog.get_by_role("textbox", name="Message", exact=True).fill("A mobile unsent draft")
                close = dialog.get_by_role("button", name="Close dialog", exact=True)
                close.focus()
                close.press("Shift+Tab")
                expect(dialog.get_by_role("button", name="Send message", exact=True)).to_be_focused()
                self.screenshot(f"{'dark' if dark else 'light'}-{width}")
                self.page.keyboard.press("Escape")
                expect(dialog).to_have_count(0)
                expect(opener).to_be_focused()

    def test_14_missing_conversation_upgrade_does_not_disable_existing_plan_tools(self):
        self.service.summary_error = "PGRST202"
        self.service.conversation_error = "PGRST202"
        self.sign_in_plans()
        expect(self.card().get_by_role("button", name="Join Real lunch invitation", exact=True)).to_be_visible()
        expect(self.card().get_by_role("button", name="Add to calendar", exact=True)).to_be_visible()
        dialog = self.conversation()
        expect(dialog.get_by_role("alert").first).to_be_visible()
        self.service.summary_error = None
        self.service.conversation_error = None
        self.refresh(dialog)
        expect(dialog.get_by_role("textbox", name="Message", exact=True)).to_be_enabled()

    def test_15_failed_ack_hides_content_without_marking_newer_message_read(self):
        first = self.service.add_message("A private message whose read permission must recheck", notify=True)
        self.service.mark_error = "42501"
        self.sign_in_plans()
        dialog = self.conversation()
        expect(dialog.get_by_role("alert").first).to_be_visible()
        expect(dialog.get_by_text(first["body"], exact=True)).to_have_count(0)
        self.assertEqual(self.service.read_ids(), set())
        self.assertIsNone(self.service.current_inbox()[0]["read_at"])
        later = self.service.add_message("A newer message during read recovery", notify=True)
        self.service.mark_error = None
        self.refresh(dialog)
        expect(dialog.get_by_text(first["body"], exact=True)).to_be_visible()
        expect(dialog.get_by_text(later["body"], exact=True)).to_be_visible()
        deadline = time.monotonic() + 5
        while later["id"] not in self.service.read_ids() and time.monotonic() < deadline:
            self.page.wait_for_timeout(10)
        self.assertSetEqual(self.service.read_ids(), {first["id"], later["id"]})

    def test_16_rejected_unread_summary_hides_an_open_private_conversation(self):
        incoming = self.service.add_message("Private content invalidated by a rejected account read")
        self.sign_in_plans()
        dialog = self.conversation()
        expect(dialog.get_by_text(incoming["body"], exact=True)).to_be_visible()
        self.service.summary_error = "42501"
        with self.page.expect_response(lambda response: "/rpc/plan_conversations_snapshot" in response.url and response.status == 403) as rejected:
            self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        rejected.value.json()
        expect(dialog.get_by_text(incoming["body"], exact=True)).to_have_count(0)
        expect(dialog.get_by_role("alert").first).to_be_visible()
        self.service.summary_error = None
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        self.refresh(dialog)
        expect(dialog.get_by_text(incoming["body"], exact=True)).to_be_visible()

    def test_17_late_conversation_read_cannot_restore_content_after_summary_rejection(self):
        incoming = self.service.add_message("A held private response that must remain hidden")
        self.sign_in_plans()
        dialog = self.conversation()
        expect(dialog.get_by_text(incoming["body"], exact=True)).to_be_visible()
        self.service.hold_conversation = True
        self.refresh(dialog)
        pending, old = self.held(self.service.held_conversations)
        self.service.summary_error = "42501"
        with self.page.expect_response(lambda response: "/rpc/plan_conversations_snapshot" in response.url and response.status == 403) as rejected:
            self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        rejected.value.json()
        expect(dialog.get_by_text(incoming["body"], exact=True)).to_have_count(0)
        with self.page.expect_response(lambda response: "/rpc/plan_conversation_snapshot" in response.url) as released:
            pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(old))
        released.value.json()
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        expect(dialog.get_by_text(incoming["body"], exact=True)).to_have_count(0)
        expect(dialog.get_by_role("alert").first).to_be_visible()

    def test_18_saved_send_with_failed_unread_reload_unlocks_and_recovers(self):
        self.sign_in_plans()
        dialog = self.conversation()
        textbox = dialog.get_by_role("textbox", name="Message", exact=True)
        textbox.fill("Saved before the unread reload failed")
        self.service.summary_error_after_send = "42501"
        dialog.get_by_role("button", name="Send message", exact=True).click()
        expect(dialog.get_by_role("alert").first).to_be_visible()
        expect(dialog.get_by_text("Saved before the unread reload failed", exact=True)).to_have_count(0)
        self.assertEqual(sum(message["body"] == "Saved before the unread reload failed"
                             for message in self.service.messages(social.PLAN_ID)), 1)
        expect(dialog.get_by_role("button", name="Refresh conversation", exact=True)).to_be_enabled()
        self.service.summary_error = None
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        self.refresh(dialog)
        expect(dialog.get_by_text("Saved before the unread reload failed", exact=True)).to_be_visible()
        expect(dialog.get_by_role("textbox", name="Message", exact=True)).to_have_value("")
        self.send(dialog, "A second message proves recovery is unlocked")

    def test_19_opened_older_plan_conversation_keeps_draft_during_authorized_revalidation(self):
        plan = self.own_plan(OLD_PLAN, "An older plan with an ongoing conversation")
        plan["owner"] = self.service.other_profiles[accounts.FRIEND_ID].copy()
        plan["invitees"] = [self.service.profile.copy()]
        plan["attendees"] = [plan["owner"].copy()]
        self.service.current_social()["plans"] = [item for item in self.service.current_social()["plans"] if item["id"] != OLD_PLAN]
        self.service.target_plans_by_user.setdefault(accounts.USER_ID, []).append(plan)
        incoming = self.service.add_message("We can still coordinate in this older plan", plan_id=OLD_PLAN, notify=True)
        self.sign_in_plans()
        self.page.get_by_role("button", name="Open notifications", exact=True).click()
        self.page.get_by_role("dialog", name="Activity inbox", exact=True).get_by_role("button").filter(has_text=plan["title"]).click()
        dialog = self.dialog()
        expect(dialog).to_be_visible()
        dialog.get_by_role("textbox", name="Message", exact=True).fill("An unsent older-plan coordination draft")
        held_targets = []
        pattern = f"**{accounts.MOCK_HOST}/rest/v1/rpc/activity_target_snapshot"
        self.context.route(pattern, lambda route: held_targets.append(route) if route.request.method == "POST" else self.service.handle(route))
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        pending = self.held(held_targets)
        expect(dialog).to_be_visible()
        expect(dialog.get_by_text(incoming["body"], exact=True)).to_be_visible()
        expect(dialog.get_by_role("textbox", name="Message", exact=True)).to_have_value("An unsent older-plan coordination draft")
        with self.page.expect_response(lambda response: "/rpc/activity_target_snapshot" in response.url) as revalidated:
            pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps({"posts": [], "plans": [plan]}))
        revalidated.value.json()
        self.context.unroute(pattern)
        expect(dialog).to_be_visible()
        expect(dialog.get_by_text(incoming["body"], exact=True)).to_be_visible()
        expect(dialog.get_by_role("textbox", name="Message", exact=True)).to_have_value("An unsent older-plan coordination draft")

    def test_20_delete_confirmation_does_not_read_unseen_replies_or_accept_a_late_page(self):
        first = self.service.add_message("A previously loaded reply")
        own = self.service.add_message("An own message being reviewed for deletion", author_id=accounts.USER_ID)
        self.sign_in_plans()
        dialog = self.conversation()
        expect(dialog.get_by_text(first["body"], exact=True)).to_be_visible()
        self.service.hold_conversation = True
        self.refresh(dialog)
        pending, old = self.held(self.service.held_conversations)
        dialog.get_by_role("button", name=f"Delete message: {own['body']}", exact=True).click()
        expect(dialog.get_by_role("heading", name="Delete this message?", exact=True)).to_be_visible()
        later = self.service.add_message("A new reply hidden behind the deletion confirmation", notify=True)
        with self.page.expect_response(lambda response: "/rpc/plan_conversation_snapshot" in response.url) as released:
            pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(old))
        released.value.json()
        calls_before = len(self.service.matching("/rest/v1/rpc/plan_conversation_snapshot", "POST"))
        with self.page.expect_response(lambda response: "/rpc/plan_conversations_snapshot" in response.url and response.status == 200) as refreshed:
            self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        refreshed.value.json()
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        expect(dialog.get_by_role("heading", name="Delete this message?", exact=True)).to_be_visible()
        expect(dialog.get_by_text(own["body"], exact=True)).to_be_visible()
        expect(dialog.get_by_text(later["body"], exact=True)).to_have_count(0)
        self.assertNotIn(later["id"], self.service.read_ids())
        self.assertEqual(len(self.service.matching("/rest/v1/rpc/plan_conversation_snapshot", "POST")), calls_before)
        self.assertIsNone(self.service.current_inbox()[0]["read_at"])
        dialog.get_by_role("button", name="Back to conversation", exact=True).click()
        self.refresh(dialog)
        expect(dialog.get_by_text(later["body"], exact=True)).to_be_visible()
        deadline = time.monotonic() + 5
        while later["id"] not in self.service.read_ids() and time.monotonic() < deadline:
            self.page.wait_for_timeout(10)
        self.assertIn(later["id"], self.service.read_ids())


if __name__ == "__main__":
    unittest.main(verbosity=2)
