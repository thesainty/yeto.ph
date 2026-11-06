"""Mocked account integration tests. These do NOT validate a hosted Supabase project.

Start two Vite servers before running this file:
  VITE_SUPABASE_URL= VITE_SUPABASE_PUBLISHABLE_KEY= \
  npm run dev -- --port 5190 --strictPort
  VITE_SUPABASE_URL=https://yeto-test.supabase.co \\
  VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test_only \\
  npm run dev -- --port 5191 --strictPort

Then: python tests/accounts.py
Python Playwright and /usr/bin/chromium are required. YETO_DEMO_TEST_URL,
YETO_ACCOUNT_TEST_URL, and YETO_CHROMIUM can override local defaults.
Every request to the deliberately fake project is fulfilled in memory.
No credentials, emails, invitations, or requests reach a remote service.
"""
import base64
import json
import os
import re
import time
import unittest
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from playwright.sync_api import sync_playwright, expect

DEMO_URL = os.environ.get("YETO_DEMO_TEST_URL", "http://127.0.0.1:5190")
ACCOUNT_URL = os.environ.get("YETO_ACCOUNT_TEST_URL", "http://127.0.0.1:5191")
MOCK_HOST = "yeto-test.supabase.co"
USER_ID = "11111111-1111-4111-8111-111111111111"
SECOND_USER_ID = "77777777-7777-4777-8777-777777777777"
FRIEND_ID = "22222222-2222-4222-8222-222222222222"
INCOMING_ID = "33333333-3333-4333-8333-333333333333"
TARGET_ID = "44444444-4444-4444-8444-444444444444"
INCOMING_REQUEST_ID = "55555555-5555-4555-8555-555555555555"
OUTGOING_REQUEST_ID = "66666666-6666-4666-8666-666666666666"
TEST_EMAIL = "maria@example.test"
TEST_PASSWORD = "Mock-password-123!"
NOW = "2026-10-31T08:00:00Z"


def open_post(page):
    """Open the compact Home composer through its visible entry point."""
    audience = page.get_by_role("dialog", name="Choose audience", exact=True)
    if audience.count():
        audience.get_by_role("button", name="Done choosing audience", exact=True).click()
    dialog = page.get_by_role("dialog", name="Create update", exact=True)
    if not dialog.count():
        page.get_by_role("button", name=re.compile(r"^(Share an update|Continue update)$")).click()
    expect(dialog).to_be_visible()
    return dialog


def open_audience(page):
    """Recipient search lives in the intentional audience step, away from Home."""
    dialog = page.get_by_role("dialog", name="Choose audience", exact=True)
    if not dialog.count():
        open_post(page).get_by_role("button", name=re.compile(r"^Audience:")).click()
    expect(dialog).to_be_visible()
    return dialog


def close_post(page):
    audience = page.get_by_role("dialog", name="Choose audience", exact=True)
    if audience.count():
        audience.get_by_role("button", name="Done choosing audience", exact=True).click()
    dialog = page.get_by_role("dialog", name="Create update", exact=True)
    if dialog.count():
        dialog.get_by_role("button", name="Close dialog", exact=True).click()


def encoded_json(value):
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


class MockAccountService:
    """A small HTTP contract fixture, not a Supabase server or authorization test."""
    def __init__(self):
        self.calls = []
        self.unhandled = []
        self.sign_in_error = False
        self.signup_session = False
        self.user_id = USER_ID
        self.email = TEST_EMAIL
        self.metadata_name = "Maria Test"
        self.profile_error = False
        self.connection_error = False
        self.mutation_error = False
        self.profile = {"id": USER_ID, "username": "maria_test", "display_name": "Maria Test"}
        self.other_profiles = {
            FRIEND_ID: {"id": FRIEND_ID, "username": "bea_real_test", "display_name": "Test Bea"},
            INCOMING_ID: {"id": INCOMING_ID, "username": "ana_real_test", "display_name": "Test Ana"},
            TARGET_ID: {"id": TARGET_ID, "username": "nico_real_test", "display_name": "Test Nico"},
        }
        self.friendships = [{"id": "friendship-fixture", "user_a": USER_ID, "user_b": FRIEND_ID, "created_at": NOW}]
        self.requests = [{"id": INCOMING_REQUEST_ID, "requester_id": INCOMING_ID, "recipient_id": USER_ID, "status": "pending", "created_at": NOW}]
        self.blocks = []
        self.recovery_redirect = None
        self.social_posts = []
        self.circles_by_user = {}
        self.circle_serial = 0
        self.circles_error = None
        self.circles_network_failure = False
        self.circle_mutation_error = False
        self.hold_circles_snapshot = False
        self.held_circles_snapshots = []
        self.row_limit = None
        self.inbox_by_user = {}
        self.inbox_error = None
        self.inbox_network_failure = False
        self.inbox_mutation_error = False
        self.hold_inbox_snapshot = False
        self.held_inbox_snapshots = []
        self.hold_inbox_mark = False
        self.held_inbox_marks = []
        self.activity_serial = 0

    def switch_user(self, user_id, display_name, username, email):
        """Select a second fictional account after sign-out, with isolated records."""
        self.user_id = user_id
        self.email = email
        self.metadata_name = display_name
        self.profile = {"id": user_id, "username": username, "display_name": display_name}
        self.friendships = []
        self.requests = []
        self.blocks = []
        self.social_posts = []

    def user(self):
        return {
            "id": self.user_id, "aud": "authenticated", "role": "authenticated", "email": self.email,
            "email_confirmed_at": NOW, "phone": "", "confirmed_at": NOW,
            "created_at": NOW, "updated_at": NOW,
            "app_metadata": {"provider": "email", "providers": ["email"]},
            "user_metadata": {"display_name": self.metadata_name},
            "identities": [], "is_anonymous": False,
        }

    def session(self):
        now = int(time.time())
        token = ".".join([
            encoded_json({"alg": "HS256", "typ": "JWT"}),
            encoded_json({"sub": self.user_id, "aud": "authenticated", "role": "authenticated", "email": self.email, "iat": now, "exp": now + 3600}),
            "bW9ja19zaWduYXR1cmVfb25seQ",
        ])
        return {"access_token": token, "token_type": "bearer", "expires_in": 3600, "expires_at": now + 3600, "refresh_token": "mock-refresh-token-only", "user": self.user()}

    def matching(self, path, method=None):
        return [call for call in self.calls if call["path"] == path and (method is None or call["method"] == method)]

    def current_circles(self):
        return self.circles_by_user.setdefault(self.user_id, [])

    def current_inbox(self):
        return self.inbox_by_user.setdefault(self.user_id, [])

    def inbox_snapshot(self):
        items = self.current_inbox()[:100]
        return {"items": items, "unread_count": sum(item["read_at"] is None for item in items)}

    def add_activity(self, kind, actor_id=FRIEND_ID, owner=None, **source):
        self.activity_serial += 1
        actor = self.profile if actor_id == self.user_id else self.other_profiles[actor_id]
        item = {
            "id": f"bbbbbbbb-bbbb-4bbb-8bbb-{self.activity_serial:012d}",
            "kind": kind, "actor": actor.copy(), "created_at": NOW, "read_at": None,
            "post_id": None, "plan_id": None, "request_id": None, "comment_id": None,
            "plan_title": None, "rsvp_going": None,
        }
        item.update(source)
        self.inbox_by_user.setdefault(owner or self.user_id, []).insert(0, item)
        return item

    def handle(self, route):
        request = route.request
        url = urlparse(request.url)
        query = parse_qs(url.query)
        try:
            body = request.post_data_json if request.post_data else None
        except Exception:
            body = None
        call = {"path": url.path, "query": query, "method": request.method, "body": body}
        self.calls.append(call)
        headers = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS", "content-type": "application/json", "x-supabase-api-version": "2024-01-01", "access-control-expose-headers": "X-Supabase-Api-Version,Content-Range"}

        def respond(value=None, status=200):
            route.fulfill(status=status, headers=headers, body=json.dumps(value) if value is not None else "")

        def fail(code, message, status=400):
            respond({"code": code, "message": message, "msg": message}, status)

        def page_rows(rows):
            # Mirror PostgREST ranges so large-list tests exercise every page.
            start = int(query.get("offset", [0])[0])
            limit = int(query.get("limit", [len(rows)])[0])
            if request.headers.get("range"):
                start, end = map(int, request.headers["range"].split("-"))
                limit = end - start + 1
            if self.row_limit is not None:
                limit = min(limit, self.row_limit)
            result = rows[start:start + limit]
            headers["content-range"] = f"{start}-{start + len(result) - 1}/{len(rows)}" if result else f"*/{len(rows)}"
            return result

        if request.method == "OPTIONS":
            respond({}, 200)
            return
        if url.path == "/auth/v1/signup":
            # Normally confirmation is required; one regression also covers auto-confirm projects.
            respond(self.session() if self.signup_session else self.user())
            return
        if url.path == "/auth/v1/token":
            if self.sign_in_error and query.get("grant_type") == ["password"]:
                fail("invalid_credentials", "Invalid login credentials")
            else:
                respond(self.session())
            return
        if url.path == "/auth/v1/user":
            respond(self.user())
            return
        if url.path == "/auth/v1/logout":
            respond(None, 204)
            return
        if url.path == "/auth/v1/recover":
            self.recovery_redirect = query.get("redirect_to", [None])[0]
            respond({})
            return
        if url.path == "/rest/v1/profiles":
            if self.profile_error:
                fail("42P01", "relation profiles does not exist", 404)
                return
            if request.method == "PATCH":
                self.profile.update(body)
                respond({"id": self.user_id})
                return
            identity = query.get("id", [""])[0]
            if identity.startswith("in.("):
                selected_ids = identity.removeprefix("in.(").removesuffix(")").split(",")
                respond(page_rows([self.other_profiles[id] for id in selected_ids if id in self.other_profiles]))
            else:
                respond(self.profile)
            return
        if url.path in ["/rest/v1/friendships", "/rest/v1/friend_requests", "/rest/v1/blocks"]:
            if self.connection_error:
                fail("42P01", "relation friendships does not exist", 404)
            elif url.path.endswith("friendships"):
                respond(page_rows(self.friendships))
            elif url.path.endswith("friend_requests"):
                respond(page_rows(self.requests))
            else:
                respond(page_rows(self.blocks))
            return
        if url.path.startswith("/rest/v1/rpc/"):
            name = url.path.split("/")[-1]
            if name == "social_snapshot":
                # Account regressions use an empty real feed. Social mutation and
                # multi-user behavior are exercised by tests/social.py.
                respond({"posts": self.social_posts, "plans": []})
                return
            if name in ["plan_polls_snapshot", "plan_poll_target_snapshot"]:
                # Account/social regressions have no availability polls. The
                # dedicated polls suite supplies its own intercepted records.
                respond({"polls": []})
                return
            if name == "plan_reminders_snapshot":
                # Existing account/social scenarios do not opt into reminders.
                # The reminders suite intercepts its own personal preferences.
                respond({"reminders": []})
                return
            if name == "plan_conversations_snapshot":
                # Conversation browser checks supply their own intercepted data.
                respond({"conversations": []})
                return
            if name == "direct_chats_snapshot":
                # Dedicated direct-chat checks supply their own intercepted data.
                respond({"chats": []})
                return
            if name == "audience_circles_snapshot":
                if self.circles_network_failure:
                    route.abort("connectionfailed")
                elif self.circles_error:
                    fail(self.circles_error, "Circles unavailable", 404)
                elif self.hold_circles_snapshot:
                    self.held_circles_snapshots.append((route, json.loads(json.dumps(self.current_circles()))))
                    self.hold_circles_snapshot = False
                else:
                    respond(self.current_circles())
                return
            if name == "activity_inbox_snapshot":
                if self.inbox_network_failure:
                    route.abort("connectionfailed")
                elif self.inbox_error:
                    fail(self.inbox_error, "Inbox unavailable", 404)
                elif self.hold_inbox_snapshot:
                    self.held_inbox_snapshots.append((route, json.loads(json.dumps(self.inbox_snapshot()))))
                    self.hold_inbox_snapshot = False
                else:
                    respond(self.inbox_snapshot())
                return
            if name == "mark_activity_read":
                if self.inbox_mutation_error:
                    fail("42501", "Read update denied", 403)
                    return
                if self.hold_inbox_mark:
                    self.held_inbox_marks.append((route, self.user_id, list(body["activity_ids"])))
                    self.hold_inbox_mark = False
                    return
                for item in self.current_inbox():
                    if item["id"] in body["activity_ids"]:
                        item["read_at"] = item["read_at"] or NOW
                respond(None)
                return
            if self.mutation_error:
                fail("42501", "permission denied", 403)
                return
            if name in ["save_audience_circle", "delete_audience_circle"]:
                if self.circle_mutation_error:
                    fail("42501", "Circle change denied", 403)
                    return
                circles = self.current_circles()
                circle_id = body["circle_id"]
                existing = next((circle for circle in circles if circle["id"] == circle_id), None)
                if name == "delete_audience_circle":
                    self.circles_by_user[self.user_id] = [circle for circle in circles if circle["id"] != circle_id]
                    respond(None)
                    return
                if circle_id is None:
                    self.circle_serial += 1
                    circle_id = f"aaaaaaaa-aaaa-4aaa-8aaa-{self.circle_serial:012d}"
                    existing = {"id": circle_id}
                    circles.append(existing)
                elif existing is None:
                    fail("42501", "Circle unavailable", 403)
                    return
                existing.update({"name": body["circle_name"].strip(), "member_ids": list(body["member_ids"])})
                respond(circle_id)
                return
            if name == "search_people":
                respond([self.other_profiles[TARGET_ID]])
                return
            if name == "send_friend_request":
                self.requests.append({"id": OUTGOING_REQUEST_ID, "requester_id": USER_ID, "recipient_id": body["target_id"], "status": "pending", "created_at": NOW})
            elif name == "cancel_friend_request":
                self.requests = [r for r in self.requests if r["id"] != body["request_id"]]
            elif name == "respond_friend_request":
                target = next(r for r in self.requests if r["id"] == body["request_id"])
                self.requests = [r for r in self.requests if r["id"] != body["request_id"]]
                self.inbox_by_user[self.user_id] = [item for item in self.current_inbox() if item["request_id"] != body["request_id"]]
                if body["accept_request"]:
                    self.friendships.append({"id": "accepted-friendship", "user_a": USER_ID, "user_b": target["requester_id"], "created_at": NOW})
            elif name in ["remove_friend", "block_person"]:
                target_id = body["target_id"]
                self.friendships = [f for f in self.friendships if target_id not in [f["user_a"], f["user_b"]]]
                for owner, circles in self.circles_by_user.items():
                    for circle in circles:
                        if owner == self.user_id:
                            circle["member_ids"] = [member for member in circle["member_ids"] if member != target_id]
                        elif owner == target_id:
                            circle["member_ids"] = [member for member in circle["member_ids"] if member != self.user_id]
                self.inbox_by_user[self.user_id] = [item for item in self.current_inbox() if item["actor"]["id"] != target_id]
                self.inbox_by_user[target_id] = [item for item in self.inbox_by_user.get(target_id, []) if item["actor"]["id"] != self.user_id]
                if name == "block_person":
                    self.requests = [r for r in self.requests if target_id not in [r["requester_id"], r["recipient_id"]]]
                    self.blocks.append({"blocked_id": target_id, "created_at": NOW})
            elif name == "unblock_person":
                self.blocks = [b for b in self.blocks if b["blocked_id"] != body["target_id"]]
            else:
                self.unhandled.append(call)
                fail("unhandled_mock", "Unhandled mock RPC", 500)
                return
            respond(None)
            return
        self.unhandled.append(call)
        fail("unhandled_mock", "Unhandled mock request", 500)


class AccountIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(executable_path=os.environ.get("YETO_CHROMIUM", "/usr/bin/chromium"), headless=True, args=["--no-sandbox"])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 1050})
        self.service = MockAccountService()
        self.unexpected_remote_hosts = []
        allowed_hosts = {urlparse(DEMO_URL).hostname, urlparse(ACCOUNT_URL).hostname}

        def local_only(route):
            host = urlparse(route.request.url).hostname
            if host in allowed_hosts:
                route.continue_()
            else:
                self.unexpected_remote_hosts.append(host)
                route.abort()

        # Refuse accidental real project/third-party calls even if a server is misconfigured.
        self.context.route("**/*", local_only)
        self.context.route(f"**{MOCK_HOST}/**", self.service.handle)
        self.page = self.context.new_page()
        self.page.set_default_timeout(9000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], "Uncaught browser errors")
        self.assertEqual(self.service.unhandled, [], "Every fake account request must have an explicit fixture")
        self.assertEqual(self.unexpected_remote_hosts, [], "Unexpected remote requests were blocked")

    def visit(self, url=ACCOUNT_URL):
        self.page.goto(url)
        expect(self.page.get_by_role("heading", name="Tara, Mika!", exact=True)).to_be_visible()

    def account(self):
        return self.page.get_by_role("dialog", name="Your TARA account", exact=True)

    def open_account(self):
        close_post(self.page)
        self.page.get_by_role("button", name="Open your profile", exact=True).click()
        if self.account().count() == 0:
            self.page.get_by_role("dialog").get_by_role("button", name="Set up your account", exact=True).click()
        expect(self.account()).to_be_visible()
        return self.account()

    def sign_in(self):
        self.visit()
        return self.submit_sign_in(self.open_account())

    def submit_sign_in(self, dialog):
        dialog.get_by_label("Email address", exact=True).fill(self.service.email)
        dialog.get_by_label(re.compile(r"^Password")).fill(TEST_PASSWORD)
        dialog.get_by_role("button", name="Sign in to TARA", exact=True).click()
        expect(dialog.get_by_role("heading", name=self.service.profile["display_name"], exact=True)).to_be_visible()
        expect(dialog.get_by_label("Display name", exact=True)).to_have_value(self.service.profile["display_name"])
        return dialog

    def demo_state(self, owner=None):
        key = "yeto-demo-v1" + (f":{owner}" if owner else "")
        self.page.wait_for_function("key => localStorage.getItem(key) !== null", arg=key)
        return self.page.evaluate("key => JSON.parse(localStorage.getItem(key))", key)

    def close_account(self):
        self.account().get_by_role("button", name="Close dialog", exact=True).click()

    def expect_shell_identity(self, full_name, username, first_name):
        expect(self.page.get_by_role("heading", name=f"Tara, {first_name}!", exact=True)).to_be_visible()
        sidebar = self.page.locator(".sidebar-profile")
        expect(sidebar).to_contain_text(full_name)
        expect(sidebar).to_contain_text(f"@{username}")
        expect(sidebar.get_by_role("img", name=full_name, exact=True)).to_be_visible()
        expect(self.page.get_by_role("main").get_by_role("heading", name="Tara, Mika!", exact=True)).to_have_count(0)

    def post_checkin(self, message):
        self.page.get_by_role("main").get_by_role("button", name="Post a check-in", exact=True).click()
        dialog = self.page.get_by_role("dialog")
        dialog.get_by_role("textbox", name="What’s your little update?", exact=True).fill(message)
        dialog.get_by_role("button", name="Post a check-in", exact=True).click()
        expect(self.page.get_by_role("main").get_by_text(message, exact=True)).to_be_visible()

    def post_comment(self, message):
        main = self.page.get_by_role("main")
        comment_input = main.get_by_role("textbox", name="Comment on Paolo’s check-in", exact=True)
        if not comment_input.is_visible():
            main.get_by_role("button", name=re.compile(r"^(Say something nice|[0-9]+ comments?)$")).click()
        comment_input.fill(message)
        main.get_by_role("button", name="Send comment", exact=True).click()
        expect(main.get_by_text(message, exact=False)).to_be_visible()

    def connections(self):
        return self.account().get_by_role("region", name="A little hello starts here.", exact=True)

    def test_01_unconfigured_accounts_keep_demo_usable(self):
        self.visit(DEMO_URL)
        self.page.get_by_role("main").get_by_role("button", name="Join plan", exact=False).click()
        expect(self.page.get_by_role("main").get_by_text("4 going, including you", exact=True)).to_be_visible()
        dialog = self.open_account()
        expect(dialog.get_by_text("Not connected yet", exact=True)).to_be_visible()
        expect(dialog.get_by_text("Create your Supabase account", exact=True)).to_be_visible()
        expect(dialog.get_by_role("link", name="Open Supabase", exact=False)).to_have_attribute("href", "https://supabase.com/dashboard")
        expect(dialog.get_by_label("Email address", exact=True)).to_have_count(0)
        self.assertEqual(self.service.calls, [])
        self.page.keyboard.press("Escape")
        self.page.reload()
        expect(self.page.get_by_role("main").get_by_text("4 going, including you", exact=True)).to_be_visible()

    def test_02_registration_requires_confirmation_without_false_signin(self):
        self.visit()
        dialog = self.open_account()
        dialog.get_by_role("button", name="Create account", exact=True).click()
        dialog.get_by_label("Your name", exact=True).fill("Maria Test")
        dialog.get_by_label("Email address", exact=True).fill(TEST_EMAIL)
        dialog.get_by_label(re.compile(r"^Password")).fill(TEST_PASSWORD)
        dialog.get_by_role("button", name="Create my TARA account", exact=True).click()
        expect(dialog.get_by_role("status")).to_contain_text("You aren’t signed in yet")
        expect(dialog.get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        expect(dialog.get_by_text("Account connected", exact=True)).to_have_count(0)
        signup = self.service.matching("/auth/v1/signup", "POST")
        self.assertEqual(len(signup), 1)
        self.assertEqual(signup[0]["body"]["data"]["display_name"], "Maria Test")
        self.assertEqual(signup[0]["body"]["email"], TEST_EMAIL)
        self.assertEqual(len(self.service.matching("/rest/v1/profiles")), 0)
        self.assertFalse(self.page.evaluate("Object.values(localStorage).some(v => v.includes('Mock-password-123!'))"))
        self.page.reload()
        dialog = self.open_account()
        expect(dialog.get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()

    def test_03_invalid_credentials_show_actionable_error(self):
        self.service.sign_in_error = True
        self.visit()
        dialog = self.open_account()
        dialog.get_by_label("Email address", exact=True).fill(TEST_EMAIL)
        dialog.get_by_label(re.compile(r"^Password")).fill("Wrong-password-only")
        dialog.get_by_role("button", name="Sign in to TARA", exact=True).click()
        expect(dialog.get_by_role("alert")).to_contain_text("That email and password don’t match")
        expect(dialog.get_by_text("Account connected", exact=True)).to_have_count(0)
        expect(dialog.get_by_role("button", name="Sign in to TARA", exact=True)).to_be_enabled()
        self.assertEqual(len(self.service.matching("/rest/v1/profiles")), 0)

    def test_04_signin_profile_update_session_reload_and_signout(self):
        dialog = self.sign_in()
        expect(dialog.get_by_text("Account connected", exact=True)).to_be_visible()
        dialog.get_by_label("Display name", exact=True).fill("Maria Updated")
        dialog.get_by_label(re.compile(r"^Username")).fill("maria_updated")
        dialog.get_by_role("button", name="Save profile", exact=True).click()
        expect(dialog.get_by_role("status").filter(has_text="Profile saved")).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/profiles", "PATCH")[-1]["body"], {"username": "maria_updated", "display_name": "Maria Updated"})
        self.page.reload()
        dialog = self.open_account()
        expect(dialog.get_by_label("Display name", exact=True)).to_have_value("Maria Updated")
        dialog.get_by_role("button", name="Sign out", exact=True).click()
        expect(dialog.get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        logout = self.service.matching("/auth/v1/logout", "POST")
        self.assertEqual(logout[-1]["query"].get("scope"), ["local"])
        self.page.reload()
        dialog = self.open_account()
        expect(dialog.get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()

    def test_05_profile_error_never_substitutes_demo_identity(self):
        self.service.profile_error = True
        self.visit()
        dialog = self.open_account()
        dialog.get_by_label("Email address", exact=True).fill(TEST_EMAIL)
        dialog.get_by_label(re.compile(r"^Password")).fill(TEST_PASSWORD)
        dialog.get_by_role("button", name="Sign in to TARA", exact=True).click()
        expect(dialog.get_by_role("alert")).to_contain_text("database setup is missing")
        expect(dialog.get_by_role("button", name="Retry profile", exact=True)).to_be_visible()
        expect(dialog.get_by_label("Display name", exact=True)).to_have_count(0)
        expect(dialog.get_by_text("Mika Reyes", exact=True)).to_have_count(0)
        self.service.profile_error = False
        dialog.get_by_role("button", name="Retry profile", exact=True).click()
        expect(dialog.get_by_label("Display name", exact=True)).to_have_value("Maria Test")

    def test_06_password_recovery_pkce_callback_and_update(self):
        self.visit()
        dialog = self.open_account()
        dialog.get_by_role("button", name="Forgot password?", exact=True).click()
        dialog.get_by_label("Email address", exact=True).fill(TEST_EMAIL)
        dialog.get_by_role("button", name="Send reset link", exact=True).click()
        expect(dialog.get_by_role("status")).to_contain_text("If that email has a TARA account")
        recover = self.service.matching("/auth/v1/recover", "POST")[-1]
        self.assertEqual(recover["body"]["email"], TEST_EMAIL)
        self.assertEqual(recover["body"]["code_challenge_method"], "s256")
        self.assertIsNotNone(self.service.recovery_redirect)
        callback = urlparse(self.service.recovery_redirect)
        query = parse_qs(callback.query)
        query["code"] = ["mock-recovery-code-only"]
        self.page.goto(urlunparse(callback._replace(query=urlencode(query, doseq=True))))
        dialog = self.account()
        expect(dialog.get_by_role("heading", name="A fresh start.", exact=True)).to_be_visible()
        dialog.get_by_label(re.compile(r"^New password")).fill("New-mock-password-456!")
        dialog.get_by_label("Confirm new password", exact=True).fill("Different-password-789!")
        dialog.get_by_role("button", name="Update password", exact=True).click()
        expect(dialog.get_by_role("alert")).to_contain_text("passwords don’t match")
        self.assertEqual(self.service.matching("/auth/v1/user", "PUT"), [])
        dialog.get_by_label("Confirm new password", exact=True).fill("New-mock-password-456!")
        dialog.get_by_role("button", name="Update password", exact=True).click()
        expect(dialog.get_by_role("status").filter(has_text="Password updated")).to_be_visible()
        self.assertEqual(self.service.matching("/auth/v1/user", "PUT")[-1]["body"]["password"], "New-mock-password-456!")
        pkce = [call for call in self.service.matching("/auth/v1/token", "POST") if call["query"].get("grant_type") == ["pkce"]]
        self.assertEqual(len(pkce), 1)
        self.assertEqual(pkce[0]["body"]["auth_code"], "mock-recovery-code-only")

    def test_07_real_connections_api_contracts(self):
        self.sign_in()
        panel = self.connections()
        expect(panel.get_by_text("Test Bea", exact=True)).to_be_visible()
        panel.get_by_label("Find someone by username", exact=True).fill("@nico_real_test")
        panel.get_by_role("button", name="Find", exact=True).click()
        expect(panel.get_by_text("Test Nico", exact=True)).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/search_people", "POST")[-1]["body"], {"search_text": "nico_real_test"})
        panel.get_by_role("button", name="Send friend request to Test Nico", exact=True).click()
        expect(panel.get_by_role("status").filter(has_text="Request sent to Test Nico")).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/send_friend_request", "POST")[-1]["body"], {"target_id": TARGET_ID})
        panel.get_by_role("button", name=re.compile("^Requests")).click()
        panel.get_by_role("button", name="Cancel friend request to Test Nico", exact=True).click()
        expect(panel.get_by_role("status").filter(has_text="Friend request cancelled")).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/cancel_friend_request", "POST")[-1]["body"], {"request_id": OUTGOING_REQUEST_ID})
        panel.get_by_role("button", name="Accept friend request from Test Ana", exact=True).click()
        expect(panel.get_by_role("status").filter(has_text="now friends")).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/respond_friend_request", "POST")[-1]["body"], {"request_id": INCOMING_REQUEST_ID, "accept_request": True})
        demo_state = self.demo_state(self.service.user_id)
        self.assertIsNone(demo_state["sharing"])
        self.assertEqual(demo_state["friendIds"], ["bea", "luis", "paolo"])
        panel.get_by_role("button", name=re.compile("^Friends")).click()
        panel.get_by_role("button", name="Remove Test Bea as a friend", exact=True).click()
        panel.get_by_role("button", name="Yes, remove", exact=True).click()
        expect(panel.get_by_role("status").filter(has_text="Friend removed")).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/remove_friend", "POST")[-1]["body"], {"target_id": FRIEND_ID})
        panel.get_by_role("button", name="Block Test Ana", exact=True).click()
        panel.get_by_role("button", name="Yes, block", exact=True).click()
        expect(panel.get_by_role("status").filter(has_text="Person blocked")).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/block_person", "POST")[-1]["body"], {"target_id": INCOMING_ID})
        panel.get_by_role("button", name=re.compile("^Blocked")).click()
        panel.get_by_role("button", name="Unblock Blocked member", exact=True).click()
        expect(panel.get_by_role("status").filter(has_text="Person unblocked")).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/unblock_person", "POST")[-1]["body"], {"target_id": INCOMING_ID})
        self.assertEqual(self.service.friendships, [])

    def test_08_connection_errors_do_not_fall_back_to_demo_people(self):
        self.service.connection_error = True
        self.sign_in()
        panel = self.connections()
        expect(panel.get_by_role("alert")).to_contain_text("database setup is missing")
        expect(panel.get_by_text("Your list isn’t available yet.", exact=True)).to_be_visible()
        for sample in ["Bea", "Luis", "Paolo", "Ana"]:
            expect(panel.get_by_text(sample, exact=True)).to_have_count(0)
        self.service.connection_error = False
        panel.get_by_role("button", name="Try again", exact=True).click()
        expect(panel.get_by_text("Test Bea", exact=True)).to_be_visible()
        self.service.mutation_error = True
        panel.get_by_role("button", name="Remove Test Bea as a friend", exact=True).click()
        panel.get_by_role("button", name="Yes, remove", exact=True).click()
        expect(panel.get_by_role("alert")).to_contain_text("don’t have permission")
        self.assertEqual(len(self.service.friendships), 1)
        expect(panel.get_by_text("Test Bea", exact=True)).to_be_visible()

    def test_09_signedin_shell_profile_and_mobile_identity(self):
        """The whole shell and profile entry follow the signed-in account."""
        dialog = self.sign_in()
        self.close_account()
        self.expect_shell_identity("Maria Test", "maria_test", "Maria")
        expect(self.page.locator(".sidebar-profile .avatar-identity-initials")).to_have_text("MT")
        self.page.locator(".sidebar-profile").click()
        expect(self.account().get_by_label("Display name", exact=True)).to_have_value("Maria Test")
        expect(self.account().get_by_text("Demo profile", exact=True)).to_have_count(0)
        self.account().get_by_label("Display name", exact=True).fill("Maria Updated")
        self.account().get_by_label(re.compile(r"^Username")).fill("maria_updated")
        self.account().get_by_role("button", name="Save profile", exact=True).click()
        expect(self.account().get_by_role("status").filter(has_text="Profile saved")).to_be_visible()
        self.close_account()
        self.expect_shell_identity("Maria Updated", "maria_updated", "Maria")
        expect(self.page.locator(".sidebar-profile .avatar-identity-initials")).to_have_text("MU")
        self.page.reload()
        self.expect_shell_identity("Maria Updated", "maria_updated", "Maria")
        self.page.set_viewport_size({"width": 375, "height": 812})
        self.page.get_by_role("button", name="Open your profile", exact=True).click()
        expect(self.account().get_by_label("Display name", exact=True)).to_have_value("Maria Updated")
        expect(self.account().get_by_text("Mika Reyes", exact=True)).to_have_count(0)
        self.assertLessEqual(self.account().bounding_box()["width"], 375)

    def test_10_demo_content_is_scoped_to_anonymous_and_each_account(self):
        """Saved sample content survives, but is never imported into real account feeds."""
        self.visit()
        self.post_checkin("Anonymous-only note")
        self.post_comment("Anonymous-only comment")
        anon = self.demo_state()
        self.assertEqual(anon["checkIns"][0]["message"], "Anonymous-only note")
        # Simulate sample records already saved before the real-feed upgrade.
        self.page.evaluate("""owner => {
            const saved = JSON.parse(localStorage.getItem('yeto-demo-v1'));
            saved.checkIns = [{id: 'legacy-maria-note', message: 'Maria-only sample check-in', audience: 'Close friends'}];
            saved.comments = ['Maria-only sample comment'];
            localStorage.setItem(`yeto-demo-v1:${owner}`, JSON.stringify(saved));
        }""", USER_ID)
        self.submit_sign_in(self.open_account())
        self.close_account()
        main = self.page.get_by_role("main")
        for sample in ["Anonymous-only note", "Maria-only sample check-in", "Maria-only sample comment"]:
            expect(main.get_by_text(sample, exact=True)).to_have_count(0)
        self.assertEqual(self.demo_state(USER_ID)["checkIns"][0]["message"], "Maria-only sample check-in")
        self.assertEqual(self.demo_state(USER_ID)["comments"], ["Maria-only sample comment"])
        self.page.get_by_role("navigation", name="Main navigation", exact=True).get_by_role("button", name="Map", exact=True).click()
        main.get_by_role("button", name="Share a journey", exact=True).click()
        self.page.get_by_role("dialog").get_by_role("button", name="Until you stop", exact=True).click()
        self.page.get_by_role("dialog").get_by_role("button", name="Start demo journey", exact=True).click()
        expect(main.get_by_role("button", name="Stop sharing", exact=True)).to_be_visible()
        self.assertIsNotNone(self.demo_state(USER_ID)["sharing"])
        self.page.get_by_role("navigation", name="Main navigation", exact=True).get_by_role("button", name="Home", exact=True).click()
        self.open_account().get_by_role("button", name="Sign out", exact=True).click()
        expect(self.account().get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        self.close_account()
        expect(main.get_by_role("heading", name="Tara, Mika!", exact=True)).to_be_visible()
        expect(main.get_by_text("Anonymous-only note", exact=True)).to_be_visible()
        expect(main.get_by_text("Anonymous-only comment", exact=True)).to_have_count(0)
        self.assertEqual(self.demo_state()["comments"], ["Anonymous-only comment"])
        expect(main.get_by_text("Maria-only sample check-in", exact=True)).to_have_count(0)
        self.assertIsNone(self.demo_state()["sharing"])
        self.submit_sign_in(self.open_account())
        self.close_account()
        expect(main.get_by_text("Maria-only sample check-in", exact=True)).to_have_count(0)
        self.assertEqual(self.demo_state(USER_ID)["comments"], ["Maria-only sample comment"])
        self.assertIsNone(self.demo_state(USER_ID)["sharing"])
        self.open_account().get_by_role("button", name="Sign out", exact=True).click()
        expect(self.account().get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        self.service.switch_user(SECOND_USER_ID, "Luna Other", "luna_other", "luna@example.test")
        self.submit_sign_in(self.account())
        self.close_account()
        self.expect_shell_identity("Luna Other", "luna_other", "Luna")
        for sample in ["Maria-only sample check-in", "Anonymous-only note", "Maria-only sample comment"]:
            expect(main.get_by_text(sample, exact=True)).to_have_count(0)
        self.assertEqual(self.demo_state(SECOND_USER_ID)["comments"], [])
        self.assertEqual(self.demo_state(SECOND_USER_ID)["checkIns"], [])
        self.page.reload()
        self.expect_shell_identity("Luna Other", "luna_other", "Luna")
        expect(main.get_by_text("Maria-only sample check-in", exact=True)).to_have_count(0)
        self.assertEqual(self.demo_state(USER_ID)["checkIns"][0]["message"], "Maria-only sample check-in")
        self.assertEqual(self.demo_state()["checkIns"][0]["message"], "Anonymous-only note")
        self.assertEqual(self.service.matching("/rest/v1/rpc/create_social_post", "POST"), [], "Sample records must never be uploaded automatically")

    def test_11_missing_profile_uses_own_metadata_without_demo_identity(self):
        """A profile failure can use auth metadata, but never Mika or a cached handle."""
        self.service.profile_error = True
        self.service.metadata_name = "Luna Metadata"
        self.visit()
        dialog = self.open_account()
        dialog.get_by_label("Email address", exact=True).fill(TEST_EMAIL)
        dialog.get_by_label(re.compile(r"^Password")).fill(TEST_PASSWORD)
        dialog.get_by_role("button", name="Sign in to TARA", exact=True).click()
        expect(dialog.get_by_role("alert")).to_contain_text("database setup is missing")
        self.close_account()
        expect(self.page.get_by_role("heading", name="Tara, Luna!", exact=True)).to_be_visible()
        sidebar = self.page.locator(".sidebar-profile")
        expect(sidebar).to_contain_text("Luna Metadata")
        expect(sidebar).not_to_contain_text("Mika")
        expect(sidebar).not_to_contain_text("mikareyes")
        expect(sidebar.get_by_role("img", name="Luna Metadata", exact=True)).to_be_visible()
        self.page.reload()
        expect(self.page.get_by_role("heading", name="Tara, Luna!", exact=True)).to_be_visible()
        self.open_account()
        expect(self.account().get_by_label("Display name", exact=True)).to_have_count(0)
        expect(self.account().get_by_text("Mika Reyes", exact=True)).to_have_count(0)

    def test_12_signup_session_immediately_updates_shell_identity(self):
        """Auto-confirm signup projects must also replace the anonymous demo identity."""
        self.service.signup_session = True
        self.visit()
        dialog = self.open_account()
        dialog.get_by_role("button", name="Create account", exact=True).click()
        dialog.get_by_label("Your name", exact=True).fill("Maria Test")
        dialog.get_by_label("Email address", exact=True).fill(TEST_EMAIL)
        dialog.get_by_label(re.compile(r"^Password")).fill(TEST_PASSWORD)
        dialog.get_by_role("button", name="Create my TARA account", exact=True).click()
        expect(dialog.get_by_label("Display name", exact=True)).to_have_value("Maria Test")
        self.close_account()
        self.expect_shell_identity("Maria Test", "maria_test", "Maria")
        self.page.reload()
        self.expect_shell_identity("Maria Test", "maria_test", "Maria")

    def test_13_unicode_account_avatar_keeps_complete_glyphs(self):
        """Profile initials handle accented letters and emoji without broken glyphs."""
        self.service.profile["display_name"] = "Élodie 🌻"
        self.service.metadata_name = "Élodie 🌻"
        self.sign_in()
        self.close_account()
        self.expect_shell_identity("Élodie 🌻", "maria_test", "Élodie")
        expect(self.page.locator(".sidebar-profile .avatar-identity-initials")).to_have_text("É🌻")

    def test_14_cross_tab_account_switch_clears_unsent_drafts(self):
        """Auth changes from another tab discard real post and comment drafts."""
        self.service.social_posts = [{
            "id": "10000000-0000-4000-8000-000000000001", "author": dict(self.service.profile),
            "body": "Maria shared fixture", "created_at": NOW, "audience_count": 0,
            "liked_by_me": False, "like_count": 0, "comments": [],
        }]
        self.sign_in()
        self.close_account()
        main = self.page.get_by_role("main")
        open_post(self.page)
        main.get_by_role("textbox", name="Your update", exact=True).fill("Maria private unsent check-in")
        close_post(self.page)
        main.get_by_role("button", name="Comments on update by Maria Test", exact=True).click()
        main.get_by_role("textbox", name="Comment on update by Maria Test", exact=True).fill("Maria private unsent comment")
        second = self.context.new_page()
        second.set_default_timeout(9000)
        second.on("pageerror", lambda error: self.errors.append(str(error)))
        second.goto(ACCOUNT_URL)
        expect(second.get_by_role("heading", name="Tara, Maria!", exact=True)).to_be_visible()
        second.get_by_role("button", name="Open your profile", exact=True).click()
        second.get_by_role("dialog", name="Your TARA account", exact=True).get_by_role("button", name="Sign out", exact=True).click()
        expect(self.page.get_by_role("heading", name="Tara, Mika!", exact=True)).to_be_visible()
        expect(self.page.get_by_role("dialog")).to_have_count(0)
        expect(main.get_by_text("Maria shared fixture", exact=True)).to_have_count(0)
        self.service.switch_user(SECOND_USER_ID, "Luna Other", "luna_other", "luna@example.test")
        self.service.social_posts = [{
            "id": "20000000-0000-4000-8000-000000000002", "author": dict(self.service.profile),
            "body": "Luna shared fixture", "created_at": NOW, "audience_count": 0,
            "liked_by_me": False, "like_count": 0, "comments": [],
        }]
        second_account = second.get_by_role("dialog", name="Your TARA account", exact=True)
        second_account.get_by_label("Email address", exact=True).fill("luna@example.test")
        second_account.get_by_label(re.compile(r"^Password")).fill(TEST_PASSWORD)
        second_account.get_by_role("button", name="Sign in to TARA", exact=True).click()
        expect(second_account.get_by_label("Display name", exact=True)).to_have_value("Luna Other")
        self.expect_shell_identity("Luna Other", "luna_other", "Luna")
        open_post(self.page)
        expect(main.get_by_role("textbox", name="Your update", exact=True)).to_have_value("")
        close_post(self.page)
        expect(main.get_by_text("Maria shared fixture", exact=True)).to_have_count(0)
        expect(main.get_by_role("textbox", name="Comment on update by Maria Test", exact=True)).to_have_count(0)
        main.get_by_role("button", name="Comments on update by Luna Other", exact=True).click()
        expect(main.get_by_role("textbox", name="Comment on update by Luna Other", exact=True)).to_have_value("")
        self.assertEqual(self.demo_state(USER_ID)["checkIns"], [])
        self.assertEqual(self.demo_state(SECOND_USER_ID)["comments"], [])
        self.assertEqual(self.service.matching("/rest/v1/rpc/create_social_post", "POST"), [])
        self.assertEqual(self.service.matching("/rest/v1/rpc/add_social_comment", "POST"), [])
        self.assertNotIn("Maria private unsent", json.dumps(self.service.calls))
        second.close()

    def test_15_storage_write_failure_cannot_revive_stopped_sharing(self):
        """A stale stored session stays ended when stopping could not be persisted."""
        self.sign_in()
        self.close_account()
        self.page.get_by_role("navigation", name="Main navigation", exact=True).get_by_role("button", name="Map", exact=True).click()
        main = self.page.get_by_role("main")
        main.get_by_role("button", name="Share a journey", exact=True).click()
        self.page.get_by_role("dialog").get_by_role("button", name="Until you stop", exact=True).click()
        self.page.get_by_role("dialog").get_by_role("button", name="Start demo journey", exact=True).click()
        expect(main.get_by_role("button", name="Stop sharing", exact=True)).to_be_visible()
        self.assertIsNotNone(self.demo_state(USER_ID)["sharing"])
        self.page.evaluate("""() => {
            window.__demoOriginalSetItem = Storage.prototype.setItem;
            window.__demoWriteFailures = 0;
            Storage.prototype.setItem = function(key, value) {
                if (key.startsWith('yeto-demo-v1')) {
                    window.__demoWriteFailures++;
                    throw new DOMException('Mock quota failure', 'QuotaExceededError');
                }
                return window.__demoOriginalSetItem.call(this, key, value);
            };
        }""")
        main.get_by_role("button", name="Stop sharing", exact=True).click()
        expect(main.get_by_role("button", name="Share a journey", exact=True)).to_be_visible()
        self.page.wait_for_function("window.__demoWriteFailures > 0")
        self.assertIsNotNone(self.demo_state(USER_ID)["sharing"], "Fixture must retain a stale active session on disk")
        self.open_account().get_by_role("button", name="Sign out", exact=True).click()
        expect(self.account().get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        self.page.evaluate("() => { Storage.prototype.setItem = window.__demoOriginalSetItem; delete window.__demoOriginalSetItem; }")
        self.submit_sign_in(self.account())
        self.close_account()
        expect(main.get_by_role("button", name="Stop sharing", exact=True)).to_have_count(0)
        expect(main.get_by_role("button", name="Share a journey", exact=True)).to_be_visible()
        self.page.wait_for_function("key => JSON.parse(localStorage.getItem(key)).sharing === null", arg=f"yeto-demo-v1:{USER_ID}")

    def test_16_failed_owner_read_cannot_revive_sharing_on_later_login(self):
        """An unreadable namespace is remembered as departed before it becomes readable."""
        self.visit()
        key = f"yeto-demo-v1:{USER_ID}"
        self.page.evaluate("""key => {
            const saved = JSON.parse(localStorage.getItem('yeto-demo-v1'));
            saved.sharing = { audience: 'Close friends', durationMinutes: null, startedAt: Date.now(), destination: 'Stale sample journey' };
            localStorage.setItem(key, JSON.stringify(saved));
            window.__demoOriginalGetItem = Storage.prototype.getItem;
            window.__demoBlockedReadKey = key;
            window.__demoReadFailures = 0;
            Storage.prototype.getItem = function(requestedKey) {
                if (requestedKey === window.__demoBlockedReadKey) {
                    window.__demoReadFailures++;
                    throw new DOMException('Mock unavailable storage', 'SecurityError');
                }
                return window.__demoOriginalGetItem.call(this, requestedKey);
            };
        }""", key)
        self.submit_sign_in(self.open_account())
        self.close_account()
        self.page.wait_for_function("window.__demoReadFailures > 0")
        self.page.get_by_role("navigation", name="Main navigation", exact=True).get_by_role("button", name="Map", exact=True).click()
        main = self.page.get_by_role("main")
        expect(main.get_by_role("button", name="Stop sharing", exact=True)).to_have_count(0)
        self.assertTrue(self.page.evaluate("key => JSON.parse(window.__demoOriginalGetItem.call(localStorage, key)).sharing !== null", key))
        self.open_account().get_by_role("button", name="Sign out", exact=True).click()
        expect(self.account().get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        self.page.evaluate("() => { Storage.prototype.getItem = window.__demoOriginalGetItem; delete window.__demoOriginalGetItem; }")
        self.submit_sign_in(self.account())
        self.close_account()
        expect(main.get_by_role("button", name="Stop sharing", exact=True)).to_have_count(0)
        expect(main.get_by_role("button", name="Share a journey", exact=True)).to_be_visible()
        self.page.wait_for_function("key => JSON.parse(localStorage.getItem(key)).sharing === null", arg=key)

    def test_17_cross_tab_auth_change_clears_unsent_credentials(self):
        """An external auth cycle cannot leave old email/password drafts in the panel."""
        self.visit()
        first_account = self.open_account()
        first_account.get_by_label("Email address", exact=True).fill("private-draft@example.test")
        first_account.get_by_label(re.compile(r"^Password")).fill("Never-submit-this-draft")
        second = self.context.new_page()
        second.set_default_timeout(9000)
        second.on("pageerror", lambda error: self.errors.append(str(error)))
        second.goto(ACCOUNT_URL)
        expect(second.get_by_role("heading", name="Tara, Mika!", exact=True)).to_be_visible()
        second.get_by_role("main").get_by_role("button", name="Set up your account", exact=True).click()
        second_account = second.get_by_role("dialog", name="Your TARA account", exact=True)
        second_account.get_by_label("Email address", exact=True).fill(TEST_EMAIL)
        second_account.get_by_label(re.compile(r"^Password")).fill(TEST_PASSWORD)
        second_account.get_by_role("button", name="Sign in to TARA", exact=True).click()
        expect(second_account.get_by_label("Display name", exact=True)).to_have_value("Maria Test")
        expect(first_account.get_by_label("Display name", exact=True)).to_have_value("Maria Test")
        second_account.get_by_role("button", name="Sign out", exact=True).click()
        expect(first_account.get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        expect(first_account.get_by_label("Email address", exact=True)).to_have_value("")
        expect(first_account.get_by_label(re.compile(r"^Password"))).to_have_value("")
        password_calls = [call for call in self.service.matching("/auth/v1/token", "POST") if call["query"].get("grant_type") == ["password"]]
        self.assertEqual(len(password_calls), 1)
        self.assertEqual(password_calls[0]["body"]["email"], TEST_EMAIL)
        self.assertNotIn("private-draft@example.test", json.dumps(self.service.calls))
        self.assertNotIn("Never-submit-this-draft", json.dumps(self.service.calls))
        second.close()


    def main_connections(self):
        self.page.get_by_role("navigation", name="Main navigation", exact=True).get_by_role("button", name=re.compile(r"^Friends")).click()
        panel = self.page.get_by_role("main").locator(".connections-panel")
        expect(panel).to_be_visible()
        return panel

    def expect_pending_badge(self, count):
        desktop = self.page.locator(".desktop-nav .nav-badge")
        mobile = self.page.locator(".mobile-nav .nav-badge")
        if count:
            expect(desktop).to_have_text(str(count))
            expect(mobile).to_have_text(str(count))
        else:
            expect(desktop).to_have_count(0)
            expect(mobile).to_have_count(0)

    def test_18_main_friends_uses_real_connections_and_updates_navigation(self):
        """The primary Friends screen uses hosted API contracts, never sample friends."""
        self.sign_in()
        self.close_account()
        self.expect_pending_badge(1)
        panel = self.main_connections()
        expect(panel.get_by_text("Test Bea", exact=True)).to_be_visible()
        for sample in ["Bea", "Luis", "Paolo", "Ana"]:
            expect(panel.get_by_text(sample, exact=True)).to_have_count(0)
        expect(self.page.get_by_role("main").get_by_text("Ana wants to connect", exact=True)).to_have_count(0)
        panel.get_by_label("Find someone by username", exact=True).fill("@nico_real_test")
        panel.get_by_role("button", name="Find", exact=True).click()
        panel.get_by_role("button", name="Send friend request to Test Nico", exact=True).click()
        expect(panel.get_by_role("status").filter(has_text="Request sent to Test Nico")).to_be_visible()
        self.expect_pending_badge(1)  # An outgoing request must not increase the incoming badge.
        self.assertEqual(self.service.matching("/rest/v1/rpc/search_people", "POST")[-1]["body"], {"search_text": "nico_real_test"})
        self.assertEqual(self.service.matching("/rest/v1/rpc/send_friend_request", "POST")[-1]["body"], {"target_id": TARGET_ID})
        panel.get_by_role("button", name=re.compile(r"^Requests")).click()
        panel.get_by_role("button", name="Cancel friend request to Test Nico", exact=True).click()
        expect(panel.get_by_role("status").filter(has_text="Friend request cancelled")).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/cancel_friend_request", "POST")[-1]["body"], {"request_id": OUTGOING_REQUEST_ID})
        panel.get_by_role("button", name="Accept friend request from Test Ana", exact=True).click()
        expect(panel.get_by_role("status").filter(has_text="now friends")).to_be_visible()
        self.expect_pending_badge(0)
        self.assertEqual(self.service.matching("/rest/v1/rpc/respond_friend_request", "POST")[-1]["body"], {"request_id": INCOMING_REQUEST_ID, "accept_request": True})
        self.assertIsNone(self.demo_state(USER_ID)["sharing"], "Real friendship must not enable demo or location sharing")
        self.assertEqual(self.demo_state(USER_ID)["friendIds"], ["bea", "luis", "paolo"], "Real friendship must not change sample sharing viewers")
        panel.get_by_role("button", name=re.compile(r"^Friends")).click()
        panel.get_by_role("button", name="Remove Test Bea as a friend", exact=True).click()
        panel.get_by_role("button", name="Yes, remove", exact=True).click()
        expect(panel.get_by_role("status").filter(has_text="Friend removed")).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/remove_friend", "POST")[-1]["body"], {"target_id": FRIEND_ID})
        panel.get_by_role("button", name="Block Test Ana", exact=True).click()
        panel.get_by_role("button", name="Yes, block", exact=True).click()
        expect(panel.get_by_role("status").filter(has_text="Person blocked")).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/block_person", "POST")[-1]["body"], {"target_id": INCOMING_ID})
        panel.get_by_role("button", name=re.compile(r"^Blocked")).click()
        panel.get_by_role("button", name="Unblock Blocked member", exact=True).click()
        expect(panel.get_by_role("status").filter(has_text="Person unblocked")).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/unblock_person", "POST")[-1]["body"], {"target_id": INCOMING_ID})
        self.assertEqual(self.service.friendships, [])
        self.page.set_viewport_size({"width": 375, "height": 812})
        self.assertLessEqual(panel.bounding_box()["width"], 375)

    def test_19_main_friends_decline_failure_and_outgoing_only_badges(self):
        """Failed mutations keep real state; outgoing requests do not create alerts."""
        self.sign_in()
        self.close_account()
        panel = self.main_connections()
        panel.get_by_role("button", name=re.compile(r"^Requests")).click()
        self.service.mutation_error = True
        panel.get_by_role("button", name="Decline friend request from Test Ana", exact=True).click()
        expect(panel.get_by_role("alert")).to_contain_text("don’t have permission")
        self.expect_pending_badge(1)
        self.assertEqual(len(self.service.requests), 1)
        self.service.mutation_error = False
        panel.get_by_role("button", name="Decline friend request from Test Ana", exact=True).click()
        expect(panel.get_by_role("status").filter(has_text="Friend request declined")).to_be_visible()
        self.expect_pending_badge(0)
        self.assertEqual(self.service.matching("/rest/v1/rpc/respond_friend_request", "POST")[-1]["body"], {"request_id": INCOMING_REQUEST_ID, "accept_request": False})
        panel.get_by_label("Find someone by username", exact=True).fill("nico_real_test")
        panel.get_by_role("button", name="Find", exact=True).click()
        panel.get_by_role("button", name="Send friend request to Test Nico", exact=True).click()
        expect(panel.get_by_role("status").filter(has_text="Request sent")).to_be_visible()
        self.expect_pending_badge(0)
        expect(panel.get_by_role("button", name="Cancel friend request to Test Nico", exact=True)).to_be_visible()
        self.assertEqual(self.service.friendships[0]["user_b"], FRIEND_ID)
        self.assertIsNone(self.demo_state(USER_ID)["sharing"])

    def test_20_main_friends_empty_failure_and_account_switch_keep_data_separate(self):
        """No anonymous names or another account's list can fill a failed/empty request."""
        self.service.connection_error = True
        self.sign_in()
        self.close_account()
        panel = self.main_connections()
        expect(panel.get_by_role("alert")).to_contain_text("database setup is missing")
        expect(panel.get_by_text("Your list isn’t available yet.", exact=True)).to_be_visible()
        for sample in ["Bea", "Luis", "Paolo", "Ana", "Test Bea"]:
            expect(panel.get_by_text(sample, exact=True)).to_have_count(0)
        self.expect_pending_badge(0)
        self.service.connection_error = False
        panel.get_by_role("button", name="Try again", exact=True).click()
        expect(panel.get_by_text("Test Bea", exact=True)).to_be_visible()
        self.expect_pending_badge(1)
        self.open_account().get_by_role("button", name="Sign out", exact=True).click()
        expect(self.account().get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        self.service.switch_user(SECOND_USER_ID, "Luna Other", "luna_other", "luna@example.test")
        self.submit_sign_in(self.account())
        self.close_account()
        panel = self.page.get_by_role("main").locator(".connections-panel")
        expect(panel.get_by_text("Your circle starts with a hello.", exact=True)).to_be_visible()
        expect(panel.get_by_text("Test Bea", exact=True)).to_have_count(0)
        expect(panel.get_by_text("Ana wants to connect", exact=True)).to_have_count(0)
        self.expect_pending_badge(0)
        self.open_account().get_by_role("button", name="Sign out", exact=True).click()
        expect(self.account().get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        self.close_account()
        expect(self.page.get_by_role("main").get_by_text("Ana wants to connect", exact=True)).to_be_visible()
        expect(self.page.get_by_role("main").locator(".connections-panel")).to_have_count(0)
        self.expect_pending_badge(1)

    def test_21_main_and_account_connections_share_refresh_and_request_state(self):
        """Requests refreshed on the main screen appear in account controls and badges."""
        self.service.requests = []
        self.sign_in()
        self.close_account()
        self.expect_pending_badge(0)
        panel = self.main_connections()
        expect(panel.get_by_text("Test Bea", exact=True)).to_be_visible()
        self.service.requests = [{"id": INCOMING_REQUEST_ID, "requester_id": INCOMING_ID, "recipient_id": USER_ID, "status": "pending", "created_at": NOW}]
        self.service.add_activity("friend_request", actor_id=INCOMING_ID, request_id=INCOMING_REQUEST_ID)
        panel.get_by_role("button", name="Refresh your connections", exact=True).click()
        self.expect_pending_badge(1)
        self.page.get_by_role("button", name="Open notifications", exact=True).click()
        notices = self.page.get_by_role("dialog", name="Activity inbox", exact=True)
        expect(notices.get_by_text("Test Ana sent you a friend request", exact=True)).to_be_visible()
        expect(notices.get_by_text("Ana wants to connect", exact=True)).to_have_count(0)
        expect(notices.get_by_text("Bea’s making coffee plans", exact=True)).to_have_count(0)
        notices.get_by_role("button", name="Close dialog", exact=True).click()
        self.page.set_viewport_size({"width": 375, "height": 812})
        expect(self.page.locator(".mobile-nav .nav-badge")).to_be_visible()
        self.page.get_by_role("button", name="Open your profile", exact=True).click()
        account_panel = self.connections()
        account_panel.get_by_role("button", name=re.compile(r"^Requests")).click()
        account_panel.get_by_role("button", name="Decline friend request from Test Ana", exact=True).click()
        expect(account_panel.get_by_role("status").filter(has_text="Friend request declined")).to_be_visible()
        self.close_account()
        panel = self.page.get_by_role("main").locator(".connections-panel")
        panel.get_by_role("button", name=re.compile(r"^Requests")).click()
        expect(panel.get_by_text("No incoming requests right now.", exact=True)).to_be_visible()
        self.expect_pending_badge(0)
        self.page.get_by_role("button", name="Open notifications", exact=True).click()
        notices = self.page.get_by_role("dialog", name="Activity inbox", exact=True)
        expect(notices.get_by_text("You’re all caught up", exact=True)).to_be_visible()
        expect(notices.get_by_text("Test Ana sent you a friend request", exact=True)).to_have_count(0)
        notices.get_by_role("button", name="Close dialog", exact=True).click()
        self.assertIsNone(self.demo_state(USER_ID)["sharing"])


    def test_22_old_account_fetch_cannot_repopulate_new_account_connections(self):
        """A late network response after account switch must never restore old friends."""
        self.sign_in()
        self.close_account()
        panel = self.main_connections()
        expect(panel.get_by_text("Test Bea", exact=True)).to_be_visible()
        held = []
        old_friends = json.loads(json.dumps(self.service.friendships))

        def hold_one_friendship_read(route):
            if not held:
                held.append(route)
            else:
                self.service.handle(route)

        self.context.route(f"**{MOCK_HOST}/rest/v1/friendships?*", hold_one_friendship_read)
        with self.page.expect_request(f"**{MOCK_HOST}/rest/v1/friendships?*"):
            panel.get_by_role("button", name="Refresh your connections", exact=True).click()
        self.open_account().get_by_role("button", name="Sign out", exact=True).click()
        expect(self.account().get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        self.service.switch_user(SECOND_USER_ID, "Luna Other", "luna_other", "luna@example.test")
        self.submit_sign_in(self.account())
        self.close_account()
        panel = self.page.get_by_role("main").locator(".connections-panel")
        expect(panel.get_by_text("Your circle starts with a hello.", exact=True)).to_be_visible()
        self.assertEqual(len(held), 1)
        self.page.evaluate("""() => {
            window.__oldConnectionsLeaked = false;
            new MutationObserver(() => {
                if (document.querySelector('main .connections-panel')?.textContent.includes('Test Bea')) {
                    window.__oldConnectionsLeaked = true;
                }
            }).observe(document.querySelector('main'), {subtree: true, childList: true, characterData: true});
        }""")
        with self.page.expect_response(re.compile(r"/rest/v1/profiles\?.*id=in")):
            held[0].fulfill(status=200, headers={"access-control-allow-origin": "*", "content-type": "application/json"}, body=json.dumps(old_friends))
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        self.assertFalse(self.page.evaluate("window.__oldConnectionsLeaked"), "Old account friends must never appear, even for one render")
        expect(panel.get_by_text("Your circle starts with a hello.", exact=True)).to_be_visible()
        expect(panel.get_by_text("Test Bea", exact=True)).to_have_count(0)
        self.expect_pending_badge(0)
        self.assertIsNone(self.demo_state(SECOND_USER_ID)["sharing"])

    def test_23_background_read_cannot_hide_completed_request_mutation(self):
        """An RPC finishing during a stale read must trigger a fresh committed snapshot."""
        self.sign_in()
        self.close_account()
        panel = self.main_connections()
        panel.get_by_role("button", name=re.compile(r"^Requests")).click()
        self.expect_pending_badge(1)
        held_rpc = []
        held_read = []
        old_requests = json.loads(json.dumps(self.service.requests))
        self.context.route(f"**{MOCK_HOST}/rest/v1/rpc/respond_friend_request", lambda route: held_rpc.append(route))

        def hold_one_request_read(route):
            if not held_read:
                held_read.append(route)
                self.page.evaluate("window.__heldConnectionRead = true")
            else:
                self.service.handle(route)

        self.context.route(f"**{MOCK_HOST}/rest/v1/friend_requests?*", hold_one_request_read)
        with self.page.expect_request(f"**{MOCK_HOST}/rest/v1/rpc/respond_friend_request"):
            panel.get_by_role("button", name="Accept friend request from Test Ana", exact=True).click()
        with self.page.expect_request(f"**{MOCK_HOST}/rest/v1/friend_requests?*"):
            self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        self.page.wait_for_function("window.__heldConnectionRead === true")
        self.assertEqual(len(held_rpc), 1)
        self.assertEqual(len(held_read), 1)
        self.service.handle(held_rpc[0])
        expect(panel.get_by_role("status").filter(has_text="now friends")).to_be_visible()
        held_read[0].fulfill(status=200, headers={"access-control-allow-origin": "*", "content-type": "application/json"}, body=json.dumps(old_requests))
        self.expect_pending_badge(0)
        expect(panel.get_by_text("No incoming requests right now.", exact=True)).to_be_visible()
        panel.get_by_role("button", name=re.compile(r"^Friends")).click()
        expect(panel.get_by_text("Test Ana", exact=True)).to_be_visible()
        self.assertIsNone(self.demo_state(USER_ID)["sharing"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
