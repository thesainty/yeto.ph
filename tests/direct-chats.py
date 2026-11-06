"""Friend-only direct chat browser contracts using intercepted fictional HTTP.

Run with the configured/unconfigured local servers described in accounts.py.
Database authorization is tested separately. No hosted accounts, messages,
email, push notifications, or external calendar services are contacted here.
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

CHAT_ID = "dddddddd-dddd-4ddd-8ddd-000000000001"
OLD_CHAT_ID = "dddddddd-dddd-4ddd-8ddd-000000000099"


class MockDirectChatService(social.MockSocialService):
    """A UI transport fixture, not an implementation of database authorization."""
    def __init__(self):
        super().__init__()
        self.chats_by_user = {}
        self.target_chats_by_user = {}
        self.messages_by_chat = {}
        self.read_by_user = {}
        self.nonces = {}
        self.chat_serial = 100
        self.message_serial = 0
        self.summary_error = None
        self.chat_error = None
        self.open_error = None
        self.send_error = None
        self.delete_error = None
        self.mark_error = None
        self.fail_after_send_once = False
        self.summary_error_after_send = None
        self.revoked_chat_ids = set()
        self.hold_chat = False
        self.held_chats = []
        self.hold_summary = False
        self.held_summaries = []
        self.hold_send = False
        self.held_sends = []
        self.hold_mark = False
        self.held_marks = []

    def current_chats(self):
        return self.chats_by_user.setdefault(self.user_id, [])

    def add_chat(self, chat_id=CHAT_ID, friend_id=accounts.FRIEND_ID, target_only=False):
        record = {"id": chat_id, "friend": self.other_profiles[friend_id].copy(), "created_at": accounts.NOW}
        bucket = self.target_chats_by_user if target_only else self.chats_by_user
        bucket.setdefault(self.user_id, []).append(record)
        self.messages_by_chat.setdefault(chat_id, [])
        return record

    def find_chat(self, chat_id):
        if chat_id in self.revoked_chat_ids:
            return None
        records = self.current_chats() + self.target_chats_by_user.get(self.user_id, [])
        return next((chat for chat in records if chat["id"] == chat_id), None)

    def read_ids(self, owner=None):
        return self.read_by_user.setdefault(owner or self.user_id, set())

    def messages(self, chat_id):
        return self.messages_by_chat.setdefault(chat_id, [])

    def unread(self, chat_id):
        return sum(message["author"]["id"] != self.user_id and message["id"] not in self.read_ids()
                   for message in self.messages(chat_id))

    def summary(self):
        result = []
        for chat in self.current_chats():
            if chat["id"] in self.revoked_chat_ids:
                continue
            messages = sorted(self.messages(chat["id"]), key=lambda item: (item["created_at"], item["id"]))
            last = messages[-1] if messages else None
            result.append({**chat, "unread_count": self.unread(chat["id"]),
                           "last_message": {"id": last["id"], "body": last["body"], "created_at": last["created_at"],
                                            "from_me": last["author"]["id"] == self.user_id} if last else None})
        result.sort(key=lambda item: (item["last_message"]["created_at"] if item["last_message"] else item["created_at"], item["id"]), reverse=True)
        return json.loads(json.dumps({"chats": result[:100]}))

    def snapshot(self, chat_id, before_created_at=None, before_id=None):
        records = sorted(self.messages(chat_id), key=lambda item: (item["created_at"], item["id"]))
        if before_created_at is not None and before_id is not None:
            records = [item for item in records if (item["created_at"], item["id"]) < (before_created_at, before_id)]
        page = records[-50:]
        more = len(records) > len(page)
        cursor = {"created_at": page[0]["created_at"], "id": page[0]["id"]} if more else None
        return json.loads(json.dumps({"chat": self.find_chat(chat_id), "messages": page, "unread_count": self.unread(chat_id),
                                      "has_more": more, "next_before": cursor}))

    def add_message(self, body, chat_id=CHAT_ID, author_id=accounts.FRIEND_ID, notify=False):
        self.message_serial += 1
        author = self.profile if author_id == self.user_id else self.other_profiles[author_id]
        message = {"id": f"eeeeeeee-eeee-4eee-8eee-{self.message_serial:012d}", "author": author.copy(), "body": body,
                   "created_at": (datetime.fromisoformat(accounts.NOW.replace("Z", "+00:00")) + timedelta(seconds=self.message_serial)).isoformat()}
        self.messages(chat_id).append(message)
        if notify:
            self.inbox_by_user[self.user_id] = [item for item in self.current_inbox()
                                                if not (item["kind"] == "direct_message" and item.get("direct_chat_id") == chat_id)]
            self.add_activity("direct_message", actor_id=author_id, direct_chat_id=chat_id, direct_message_id=message["id"])
        return message

    def commit_send(self, owner, profile, body):
        key = (owner, body["chat_id"], body["client_nonce"])
        if key in self.nonces:
            return self.nonces[key]
        self.message_serial += 1
        message = {"id": f"eeeeeeee-eeee-4eee-8eee-{self.message_serial:012d}", "author": profile.copy(),
                   "body": body["body_text"], "created_at": datetime.now(timezone.utc).isoformat()}
        self.messages(body["chat_id"]).append(message)
        self.nonces[key] = message["id"]
        return message["id"]

    def apply_read(self, owner, body):
        self.read_ids(owner).update(body["message_ids"])
        for item in self.inbox_by_user.get(owner, []):
            if item["kind"] == "direct_message" and item.get("direct_chat_id") == body["chat_id"] and item.get("direct_message_id") in body["message_ids"]:
                item["read_at"] = item["read_at"] or accounts.NOW

    def revoke_chat(self, chat_id):
        self.revoked_chat_ids.add(chat_id)
        self.messages_by_chat.pop(chat_id, None)
        for owner, records in self.chats_by_user.items():
            self.chats_by_user[owner] = [chat for chat in records if chat["id"] != chat_id]
        for owner, records in self.target_chats_by_user.items():
            self.target_chats_by_user[owner] = [chat for chat in records if chat["id"] != chat_id]
        for owner, records in self.inbox_by_user.items():
            self.inbox_by_user[owner] = [item for item in records if item.get("direct_chat_id") != chat_id]

    def handle(self, route):
        request = route.request
        url = urlparse(request.url)
        name = url.path.split("/")[-1]
        if request.method == "POST" and name in ["remove_friend", "block_person"]:
            friend = (request.post_data_json or {}).get("target_id")
            for chat in list(self.current_chats()) + list(self.target_chats_by_user.get(self.user_id, [])):
                if chat["friend"]["id"] == friend:
                    self.revoke_chat(chat["id"])
        names = {"direct_chats_snapshot", "open_direct_chat", "direct_chat_snapshot", "send_direct_message", "delete_direct_message", "mark_direct_messages_read"}
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
            respond({"code": code, "message": "Direct chat unavailable"}, 404 if code == "PGRST202" else 403)

        if name == "direct_chats_snapshot":
            if self.summary_error:
                fail(self.summary_error)
            elif self.hold_summary:
                self.held_summaries.append((route, self.summary()))
                self.hold_summary = False
            else:
                respond(self.summary())
        elif name == "open_direct_chat":
            if self.open_error:
                fail(self.open_error)
                return
            friend_id = body["friend_id"]
            valid = any(self.user_id in [row["user_a"], row["user_b"]] and friend_id in [row["user_a"], row["user_b"]]
                        for row in self.friendships)
            if not valid or friend_id == self.user_id:
                fail("42501")
                return
            found = next((chat for chat in self.current_chats() if chat["friend"]["id"] == friend_id), None)
            if not found:
                self.chat_serial += 1
                found = self.add_chat(f"dddddddd-dddd-4ddd-8ddd-{self.chat_serial:012d}", friend_id)
            respond(found["id"])
        elif name == "direct_chat_snapshot":
            if self.chat_error or not self.find_chat(body["chat_id"]):
                fail(self.chat_error or "42501")
            elif self.hold_chat:
                self.held_chats.append((route, self.snapshot(body["chat_id"], body.get("before_created_at"), body.get("before_id"))))
                self.hold_chat = False
            else:
                respond(self.snapshot(body["chat_id"], body.get("before_created_at"), body.get("before_id")))
        elif name == "send_direct_message":
            if self.send_error:
                fail(self.send_error)
            elif self.hold_send:
                self.held_sends.append((route, self.user_id, self.profile.copy(), body.copy()))
                self.hold_send = False
            else:
                saved = self.commit_send(self.user_id, self.profile, body)
                if self.summary_error_after_send:
                    self.summary_error = self.summary_error_after_send
                    self.summary_error_after_send = None
                if self.fail_after_send_once:
                    self.fail_after_send_once = False
                    fail("P0001")
                else:
                    respond(saved)
        elif name == "delete_direct_message":
            if self.delete_error:
                fail(self.delete_error)
            else:
                for chat_id, records in self.messages_by_chat.items():
                    self.messages_by_chat[chat_id] = [message for message in records if message["id"] != body["message_id"]]
                for owner, records in self.inbox_by_user.items():
                    self.inbox_by_user[owner] = [item for item in records if item.get("direct_message_id") != body["message_id"]]
                respond()
        elif name == "mark_direct_messages_read":
            if self.mark_error:
                fail(self.mark_error)
            elif self.hold_mark:
                self.held_marks.append((route, self.user_id, body.copy()))
                self.hold_mark = False
            else:
                self.apply_read(self.user_id, body)
                respond()


class DirectChatBrowserTests(unittest.TestCase):
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
        self.service = MockDirectChatService()
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
        self.page.get_by_role("navigation", name=nav, exact=True).get_by_role("button", name=re.compile(rf"^{tab}")).click()

    def sign_in_chats(self):
        self.sign_in_feed()
        self.navigate("Chats")
        expect(self.chats()).to_be_visible()

    def chats(self):
        return self.page.get_by_role("region", name="Chats", exact=True)

    def pane(self):
        return self.page.get_by_role("region", name="Direct conversation", exact=True)

    def messages(self):
        return self.pane().get_by_role("list", name="Direct messages", exact=True)

    def open_chat(self, friend="Test Bea"):
        self.chats().get_by_role("button", name=f"Open chat with {friend}", exact=True).click()
        expect(self.pane().get_by_role("textbox", name="Message", exact=True)).to_be_visible()
        return self.pane()

    def new_chat(self, friend="Test Bea"):
        self.chats().get_by_role("button", name="New chat", exact=True).click()
        modal = self.page.get_by_role("dialog", name="New chat", exact=True)
        expect(modal).to_be_visible()
        modal.get_by_role("button", name=f"Chat with {friend}", exact=True).click()
        expect(modal).to_have_count(0)
        expect(self.pane().get_by_role("textbox", name="Message", exact=True)).to_be_visible()
        return self.pane()

    def send(self, body):
        self.pane().get_by_role("textbox", name="Message", exact=True).fill(body)
        self.pane().get_by_role("button", name="Send message", exact=True).click()
        expect(self.pane().get_by_role("textbox", name="Message", exact=True)).to_have_value("")
        expect(self.messages().get_by_text(body.strip(), exact=True)).to_be_visible()

    def refresh(self):
        self.pane().get_by_role("button", name="Refresh chat", exact=True).click()

    def held(self, queue):
        deadline = time.monotonic() + 5
        while not queue and time.monotonic() < deadline:
            self.page.wait_for_timeout(10)
        self.assertTrue(queue, "Expected intercepted request was not queued")
        return queue.pop()

    def read_complete(self, ids):
        deadline = time.monotonic() + 5
        while not set(ids).issubset(self.service.read_ids()) and time.monotonic() < deadline:
            self.page.wait_for_timeout(10)
        self.assertTrue(set(ids).issubset(self.service.read_ids()))

    def add_friend(self, friend_id=accounts.INCOMING_ID):
        self.service.friendships.append({"id": f"fixture-{friend_id}", "user_a": self.service.user_id,
                                         "user_b": friend_id, "created_at": accounts.NOW})

    def switch_account_in_second_tab(self):
        second = self.context.new_page()
        second.set_default_timeout(9000)
        second.on("pageerror", lambda error: self.errors.append(str(error)))
        second.goto(accounts.ACCOUNT_URL)
        expect(second.get_by_role("heading", name="Tara, Maria!", exact=True)).to_be_visible()
        second.get_by_role("button", name="Open your profile", exact=True).click()
        modal = second.get_by_role("dialog", name="Your TARA account", exact=True)
        modal.get_by_role("button", name="Sign out", exact=True).click()
        self.service.switch_user(accounts.SECOND_USER_ID, "Luna Other", "luna_other", "luna@example.test")
        modal.get_by_label("Email address", exact=True).fill(self.service.email)
        modal.get_by_label(re.compile(r"^Password")).fill(accounts.TEST_PASSWORD)
        modal.get_by_role("button", name="Sign in to TARA", exact=True).click()
        expect(modal.get_by_label("Display name", exact=True)).to_have_value("Luna Other")
        expect(self.page.get_by_role("button", name="Open your profile", exact=True).get_by_role("img", name="Luna Other", exact=True)).to_be_visible()
        return second

    def screenshot(self, name):
        Path("test-results").mkdir(exist_ok=True)
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        self.page.screenshot(path=f"test-results/direct-chats-{name}.png")

    def test_01_anonymous_chats_request_sign_in_without_content_writes(self):
        self.visit(accounts.DEMO_URL)
        self.navigate("Chats")
        expect(self.chats().get_by_role("button", name="Sign in to chat", exact=True)).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/send_direct_message", "POST"), [])
        self.assertEqual(self.service.matching("/rest/v1/rpc/open_direct_chat", "POST"), [])

    def test_02_new_chat_search_is_current_friends_only_and_open_sends_nothing(self):
        self.sign_in_chats()
        self.chats().get_by_role("button", name="New chat", exact=True).click()
        modal = self.page.get_by_role("dialog", name="New chat", exact=True)
        search = modal.get_by_role("searchbox", name="Search friends to message", exact=True)
        search.fill("nico")
        expect(modal.get_by_role("button", name="Chat with Test Nico", exact=True)).to_have_count(0)
        search.fill("bea_real")
        expect(modal.get_by_role("button", name="Chat with Test Bea", exact=True)).to_be_visible()
        modal.get_by_role("button", name="Chat with Test Bea", exact=True).click()
        expect(modal).to_have_count(0)
        expect(self.pane().get_by_role("textbox", name="Message", exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("open_direct_chat"), {"friend_id": accounts.FRIEND_ID})
        self.assertEqual(self.service.matching("/rest/v1/rpc/search_people", "POST"), [])
        self.assertEqual(self.service.matching("/rest/v1/rpc/send_direct_message", "POST"), [])
        self.assertEqual(self.service.current_inbox(), [])
        self.new_chat()
        self.assertEqual(len(self.service.current_chats()), 1)

    def test_03_send_plain_text_emoji_and_only_explicit_chat_body_nonce(self):
        self.service.add_chat()
        self.sign_in_chats()
        self.open_chat()
        self.send("Kumusta, barkada 🌻 <script>never HTML</script>")
        body = self.rpc_body("send_direct_message")
        self.assertEqual(set(body), {"chat_id", "body_text", "client_nonce"})
        self.assertEqual(body["chat_id"], CHAT_ID)
        self.assertRegex(body["client_nonce"], r"^[0-9a-f-]{36}$")
        self.assertEqual(self.pane().locator("script").count(), 0)
        textbox = self.pane().get_by_role("textbox", name="Message", exact=True)
        textbox.fill("   ")
        expect(self.pane().get_by_role("button", name="Send message", exact=True)).to_be_disabled()
        expect(textbox).to_have_attribute("maxlength", "1000")
        self.send("A" * 1000)
        self.assertFalse(self.page.evaluate("Object.values(localStorage).some(value => value.includes('Kumusta, barkada'))"))

    def test_04_chat_list_search_and_unread_belong_to_the_selected_friend(self):
        self.add_friend()
        self.service.add_chat()
        self.service.add_chat("dddddddd-dddd-4ddd-8ddd-000000000002", accounts.INCOMING_ID)
        self.service.add_message("Bea’s private hello")
        self.sign_in_chats()
        search = self.chats().get_by_role("searchbox", name="Search chats", exact=True)
        search.fill("ana_real")
        expect(self.chats().get_by_role("button", name="Open chat with Test Ana", exact=True)).to_be_visible()
        expect(self.chats().get_by_role("button", name="Open chat with Test Bea", exact=True)).to_have_count(0)
        search.fill("")
        self.open_chat()
        expect(self.messages().get_by_text("Bea’s private hello", exact=True)).to_be_visible()
        self.read_complete([self.service.messages(CHAT_ID)[0]["id"]])

    def test_05_failed_send_keeps_draft_and_retry_reuses_nonce_without_duplicate(self):
        self.service.add_chat()
        self.sign_in_chats()
        self.open_chat()
        self.service.fail_after_send_once = True
        body = "An uncertain send should only be saved once"
        self.pane().get_by_role("textbox", name="Message", exact=True).fill(body)
        self.pane().get_by_role("button", name="Send message", exact=True).click()
        expect(self.pane().get_by_role("alert").first).to_be_visible()
        self.refresh()
        expect(self.messages().get_by_text(body, exact=True)).to_be_visible()
        expect(self.pane().get_by_role("textbox", name="Message", exact=True)).to_have_value(body)
        self.pane().get_by_role("button", name="Send message", exact=True).click()
        expect(self.pane().get_by_role("textbox", name="Message", exact=True)).to_have_value("")
        calls = self.service.matching("/rest/v1/rpc/send_direct_message", "POST")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["body"]["client_nonce"], calls[1]["body"]["client_nonce"])
        self.assertEqual(sum(message["body"] == body for message in self.service.messages(CHAT_ID)), 1)

    def test_06_history_keysets_acknowledge_loaded_messages_and_refresh_deletions(self):
        self.service.add_chat()
        records = [self.service.add_message(f"Earlier friend message {index:02}") for index in range(65)]
        self.sign_in_chats()
        self.open_chat()
        expect(self.messages().get_by_text(records[15]["body"], exact=True)).to_be_visible()
        expect(self.messages().get_by_text(records[0]["body"], exact=True)).to_have_count(0)
        self.read_complete([record["id"] for record in records[15:]])
        self.assertNotIn(records[0]["id"], self.service.read_ids())
        self.pane().get_by_role("button", name="Load earlier messages", exact=True).click()
        expect(self.messages().get_by_text(records[0]["body"], exact=True)).to_be_visible()
        self.read_complete([record["id"] for record in records])
        calls = self.service.matching("/rest/v1/rpc/direct_chat_snapshot", "POST")
        self.assertIn({"chat_id": CHAT_ID, "before_created_at": records[15]["created_at"], "before_id": records[15]["id"]}, [call["body"] for call in calls])
        self.service.messages_by_chat[CHAT_ID] = records[1:]
        self.refresh()
        expect(self.messages().get_by_text(records[0]["body"], exact=True)).to_have_count(0)
        expect(self.messages().get_by_text(records[1]["body"], exact=True)).to_be_visible()

    def test_07_exact_read_does_not_acknowledge_a_concurrently_arriving_message(self):
        self.service.add_chat()
        first = self.service.add_message("The message currently loaded", notify=True)
        self.service.hold_mark = True
        self.sign_in_chats()
        self.open_chat()
        pending, owner, body = self.held(self.service.held_marks)
        newer = self.service.add_message("A newer reply during acknowledgement", notify=True)
        self.assertEqual(body, {"chat_id": CHAT_ID, "message_ids": [first["id"]]})
        self.service.apply_read(owner, body)
        pending.fulfill(status=200, headers=social.HEADERS, body="null")
        self.assertNotIn(newer["id"], self.service.read_ids())
        self.assertIsNone(self.service.current_inbox()[0]["read_at"])
        self.refresh()
        expect(self.messages().get_by_text(newer["body"], exact=True)).to_be_visible()

    def test_08_only_own_messages_can_be_deleted_and_failure_recovers(self):
        self.service.add_chat()
        incoming = self.service.add_message("Bea’s message remains")
        own = self.service.add_message("Delete my direct message", author_id=accounts.USER_ID)
        self.sign_in_chats()
        self.open_chat()
        expect(self.pane().get_by_role("button", name=f"Delete message: {incoming['body']}", exact=True)).to_have_count(0)
        self.pane().get_by_role("button", name=f"Delete message: {own['body']}", exact=True).click()
        modal = self.page.get_by_role("dialog", name="Delete this message?", exact=True)
        modal.get_by_role("button", name="Keep message", exact=True).click()
        expect(self.messages().get_by_text(own["body"], exact=True)).to_be_visible()
        self.pane().get_by_role("button", name=f"Delete message: {own['body']}", exact=True).click()
        self.service.delete_error = "42501"
        modal.get_by_role("button", name="Yes, delete message", exact=True).click()
        expect(self.page.get_by_role("alert").first).to_be_visible()
        self.service.delete_error = None
        if modal.count():
            modal.get_by_role("button", name="Close dialog", exact=True).click()
        self.refresh()
        self.pane().get_by_role("button", name=f"Delete message: {own['body']}", exact=True).click()
        modal.get_by_role("button", name="Yes, delete message", exact=True).click()
        expect(modal).to_have_count(0)
        expect(self.messages().get_by_text(own["body"], exact=True)).to_have_count(0)
        expect(self.messages().get_by_text(incoming["body"], exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("delete_direct_message"), {"message_id": own["id"]})

    def test_09_coalesced_inbox_opens_an_exact_older_thread(self):
        self.service.add_chat(OLD_CHAT_ID, target_only=True)
        self.service.add_message("An older direct hello", OLD_CHAT_ID, notify=True)
        latest = self.service.add_message("The latest older direct message", OLD_CHAT_ID, notify=True)
        self.assertEqual(len(self.service.current_inbox()), 1)
        self.sign_in_chats()
        expect(self.chats().get_by_role("button", name="Open chat with Test Bea", exact=True)).to_have_count(0)
        self.page.get_by_role("button", name="Open notifications", exact=True).click()
        inbox = self.page.get_by_role("dialog", name="Activity inbox", exact=True)
        inbox.get_by_role("button").filter(has_text="Test Bea").click()
        expect(inbox).to_have_count(0)
        expect(self.messages().get_by_text(latest["body"], exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("direct_chat_snapshot")["chat_id"], OLD_CHAT_ID)
        self.assertNotIn("body", self.service.current_inbox()[0])

    def test_10_failed_read_hides_private_content_and_can_recover(self):
        self.service.add_chat()
        incoming = self.service.add_message("Private direct content rejected on refresh")
        self.sign_in_chats()
        self.open_chat()
        expect(self.messages().get_by_text(incoming["body"], exact=True)).to_be_visible()
        self.service.chat_error = "42501"
        self.refresh()
        expect(self.pane().get_by_role("alert").first).to_be_visible()
        expect(self.pane().get_by_text(incoming["body"], exact=True)).to_have_count(0)
        self.service.chat_error = None
        self.refresh()
        expect(self.messages().get_by_text(incoming["body"], exact=True)).to_be_visible()

    def test_11_rejected_summary_invalidates_open_content_and_an_inflight_read(self):
        self.service.add_chat()
        incoming = self.service.add_message("A held private direct response")
        self.sign_in_chats()
        self.open_chat()
        self.service.hold_chat = True
        self.refresh()
        pending, old = self.held(self.service.held_chats)
        self.service.summary_error = "42501"
        with self.page.expect_response(lambda response: "/rpc/direct_chats_snapshot" in response.url and response.status == 403) as rejected:
            self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        rejected.value.json()
        expect(self.pane().get_by_text(incoming["body"], exact=True)).to_have_count(0)
        pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(old))
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        expect(self.pane().get_by_text(incoming["body"], exact=True)).to_have_count(0)
        expect(self.pane().get_by_role("alert").first).to_be_visible()

    def test_12_saved_send_with_failed_summary_unlocks_and_recovers(self):
        self.service.add_chat()
        self.sign_in_chats()
        self.open_chat()
        self.service.summary_error_after_send = "42501"
        self.pane().get_by_role("textbox", name="Message", exact=True).fill("Saved before an unread refresh failure")
        self.pane().get_by_role("button", name="Send message", exact=True).click()
        expect(self.page.get_by_role("alert").first).to_be_visible()
        self.assertEqual(sum(message["body"] == "Saved before an unread refresh failure" for message in self.service.messages(CHAT_ID)), 1)
        expect(self.pane().get_by_role("button", name="Refresh chat", exact=True)).to_be_enabled()
        self.service.summary_error = None
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        self.refresh()
        expect(self.messages().get_by_text("Saved before an unread refresh failure", exact=True)).to_be_visible()
        self.send("A second send proves this chat unlocked")

    def test_13_late_read_and_draft_cannot_survive_an_account_switch(self):
        self.service.add_chat()
        incoming = self.service.add_message("Maria’s old private direct history")
        self.sign_in_chats()
        self.open_chat()
        self.pane().get_by_role("textbox", name="Message", exact=True).fill("Maria’s old private unsent draft")
        self.service.hold_chat = True
        self.refresh()
        pending, old = self.held(self.service.held_chats)
        second = self.switch_account_in_second_tab()
        pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(old))
        expect(self.page.get_by_text(incoming["body"], exact=True)).to_have_count(0)
        expect(self.page.get_by_role("textbox", name="Message", exact=True)).to_have_count(0)
        second.close()

    def test_14_late_send_cannot_show_old_feedback_or_content_on_a_new_account(self):
        self.service.add_chat()
        self.sign_in_chats()
        self.open_chat()
        self.service.hold_send = True
        self.pane().get_by_role("textbox", name="Message", exact=True).fill("An in-flight Maria direct message")
        self.pane().get_by_role("button", name="Send message", exact=True).click()
        pending, owner, profile, body = self.held(self.service.held_sends)
        second = self.switch_account_in_second_tab()
        saved = self.service.commit_send(owner, profile, body)
        pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(saved))
        expect(self.page.get_by_text("An in-flight Maria direct message", exact=True)).to_have_count(0)
        expect(self.page.get_by_text("Message sent.", exact=True)).to_have_count(0)
        self.assertEqual(self.service.current_chats(), [])
        second.close()

    def test_15_late_summary_cannot_restore_old_account_chat_rows(self):
        self.service.add_chat()
        self.service.add_message("An old account thread preview")
        self.sign_in_chats()
        self.service.hold_summary = True
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        pending, old = self.held(self.service.held_summaries)
        second = self.switch_account_in_second_tab()
        pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(old))
        expect(self.chats().get_by_role("button", name="Open chat with Test Bea", exact=True)).to_have_count(0)
        expect(self.page.get_by_text("An old account thread preview", exact=True)).to_have_count(0)
        second.close()

    def test_16_removal_revokes_held_history_and_refriending_starts_a_fresh_chat(self):
        self.service.add_chat()
        incoming = self.service.add_message("History that must not return after re-friending")
        self.sign_in_chats()
        self.open_chat()
        self.service.hold_chat = True
        self.refresh()
        pending, old = self.held(self.service.held_chats)
        self.service.friendships = []
        self.service.revoke_chat(CHAT_ID)
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(self.page.get_by_role("textbox", name="Message", exact=True)).to_have_count(0)
        pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(old))
        expect(self.page.get_by_text(incoming["body"], exact=True)).to_have_count(0)
        self.add_friend(accounts.FRIEND_ID)
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        self.new_chat()
        self.assertNotEqual(self.rpc_body("direct_chat_snapshot")["chat_id"], CHAT_ID)
        expect(self.pane().get_by_text(incoming["body"], exact=True)).to_have_count(0)

    def test_17_new_chat_modal_does_not_read_hidden_new_replies_or_accept_a_late_page(self):
        self.service.add_chat()
        self.service.add_message("An already loaded reply")
        self.sign_in_chats()
        self.open_chat()
        self.service.hold_chat = True
        self.refresh()
        pending, old = self.held(self.service.held_chats)
        self.chats().get_by_role("button", name="New chat", exact=True).click()
        modal = self.page.get_by_role("dialog", name="New chat", exact=True)
        later = self.service.add_message("A new reply hidden by New chat", notify=True)
        pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(old))
        calls = len(self.service.matching("/rest/v1/rpc/direct_chat_snapshot", "POST"))
        with self.page.expect_response(lambda response: "/rpc/direct_chats_snapshot" in response.url) as refreshed:
            self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        refreshed.value.json()
        self.assertEqual(len(self.service.matching("/rest/v1/rpc/direct_chat_snapshot", "POST")), calls)
        self.assertNotIn(later["id"], self.service.read_ids())
        modal.get_by_role("button", name="Close dialog", exact=True).click()
        self.refresh()
        expect(self.messages().get_by_text(later["body"], exact=True)).to_be_visible()

    def test_18_delete_confirmation_does_not_read_hidden_new_replies(self):
        self.service.add_chat()
        own = self.service.add_message("An own message pending deletion", author_id=accounts.USER_ID)
        self.sign_in_chats()
        self.open_chat()
        self.pane().get_by_role("button", name=f"Delete message: {own['body']}", exact=True).click()
        modal = self.page.get_by_role("dialog", name="Delete this message?", exact=True)
        later = self.service.add_message("A new reply hidden by Delete", notify=True)
        calls = len(self.service.matching("/rest/v1/rpc/direct_chat_snapshot", "POST"))
        with self.page.expect_response(lambda response: "/rpc/direct_chats_snapshot" in response.url) as refreshed:
            self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        refreshed.value.json()
        self.assertEqual(len(self.service.matching("/rest/v1/rpc/direct_chat_snapshot", "POST")), calls)
        self.assertNotIn(later["id"], self.service.read_ids())
        modal.get_by_role("button", name="Keep message", exact=True).click()
        self.refresh()
        expect(self.messages().get_by_text(later["body"], exact=True)).to_be_visible()

    def test_19_mobile_back_navigation_themes_emoji_and_keyboard_fit(self):
        self.service.add_chat()
        self.service.add_message("Kita-kits, pamilya 🌻")
        self.sign_in_chats()
        for dark in (False, True):
            toggle = self.page.get_by_role("switch", name="Dark mode", exact=True)
            if (toggle.get_attribute("aria-checked") == "true") != dark:
                toggle.click()
            for width in (375, 320):
                self.page.set_viewport_size({"width": width, "height": 812})
                self.open_chat()
                textbox = self.pane().get_by_role("textbox", name="Message", exact=True)
                textbox.fill("A mobile direct draft")
                self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth"), width)
                self.screenshot(f"{'dark' if dark else 'light'}-{width}")
                self.pane().get_by_role("button", name="Back to chats", exact=True).click()
                expect(self.chats().get_by_role("searchbox", name="Search chats", exact=True)).to_be_visible()
                self.open_chat()
                expect(textbox).to_have_value("A mobile direct draft")
                self.pane().get_by_role("button", name="Back to chats", exact=True).click()
                opener = self.chats().get_by_role("button", name="New chat", exact=True)
                opener.click()
                self.page.keyboard.press("Escape")
                expect(self.page.get_by_role("dialog", name="New chat", exact=True)).to_have_count(0)
                expect(opener).to_be_focused()
        self.page.set_viewport_size({"width": 1440, "height": 1050})
        self.open_chat()
        textbox = self.pane().get_by_role("textbox", name="Message", exact=True)
        textbox.fill("Hello ")
        self.pane().get_by_role("button", name="Add emoji", exact=True).click()
        self.pane().get_by_role("button", name="Wave", exact=True).click()
        expect(textbox).to_have_value("Hello 👋")
        self.screenshot("desktop")

    def test_20_unavailable_upgrade_does_not_disable_plans_and_recovers(self):
        self.service.summary_error = "PGRST202"
        self.sign_in_chats()
        expect(self.page.get_by_role("alert").first).to_be_visible()
        self.navigate("Plans")
        expect(self.page.get_by_role("button", name="Join Real lunch invitation", exact=True)).to_be_visible()
        self.service.summary_error = None
        self.navigate("Chats")
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        self.new_chat()
        expect(self.pane().get_by_role("textbox", name="Message", exact=True)).to_be_enabled()

    def test_21_activity_inbox_does_not_read_a_hidden_new_reply(self):
        self.service.add_chat()
        self.service.add_message("A conversation before opening notifications")
        self.sign_in_chats()
        self.open_chat()
        self.service.hold_chat = True
        self.refresh()
        pending, old = self.held(self.service.held_chats)
        self.page.get_by_role("button", name="Open notifications", exact=True).click()
        inbox = self.page.get_by_role("dialog", name="Activity inbox", exact=True)
        expect(inbox).to_be_visible()
        later = self.service.add_message("A new reply hidden by the activity inbox", notify=True)
        pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(old))
        calls = len(self.service.matching("/rest/v1/rpc/direct_chat_snapshot", "POST"))
        with self.page.expect_response(lambda response: "/rpc/direct_chats_snapshot" in response.url) as refreshed:
            self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        refreshed.value.json()
        self.assertEqual(len(self.service.matching("/rest/v1/rpc/direct_chat_snapshot", "POST")), calls)
        self.assertNotIn(later["id"], self.service.read_ids())
        self.assertIsNone(self.service.current_inbox()[0]["read_at"])
        inbox.get_by_role("button", name="Close dialog", exact=True).click()
        self.refresh()
        expect(self.messages().get_by_text(later["body"], exact=True)).to_be_visible()

    def test_22_read_ack_failure_preserves_personal_unread_and_recovers(self):
        self.service.add_chat()
        incoming = self.service.add_message("An unread message whose acknowledgement fails", notify=True)
        self.service.mark_error = "42501"
        self.sign_in_chats()
        self.open_chat()
        expect(self.pane().get_by_role("alert").first).to_be_visible()
        expect(self.pane().get_by_text(incoming["body"], exact=True)).to_have_count(0)
        self.assertNotIn(incoming["id"], self.service.read_ids())
        self.assertIsNone(self.service.current_inbox()[0]["read_at"])
        self.service.mark_error = None
        self.refresh()
        self.read_complete([incoming["id"]])
        expect(self.messages().get_by_text(incoming["body"], exact=True)).to_be_visible()
        self.assertIsNotNone(self.service.current_inbox()[0]["read_at"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
