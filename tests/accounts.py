"""Mocked account integration tests. These do NOT validate a hosted Supabase project.

Start two Vite servers before running this file:
  npm run dev -- --port 5173 --strictPort
  VITE_SUPABASE_URL=https://yeto-test.supabase.co \\
  VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test_only \\
  npm run dev -- --port 5180 --strictPort

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

DEMO_URL = os.environ.get("YETO_DEMO_TEST_URL", "http://127.0.0.1:5173")
ACCOUNT_URL = os.environ.get("YETO_ACCOUNT_TEST_URL", "http://127.0.0.1:5180")
MOCK_HOST = "yeto-test.supabase.co"
USER_ID = "11111111-1111-4111-8111-111111111111"
FRIEND_ID = "22222222-2222-4222-8222-222222222222"
INCOMING_ID = "33333333-3333-4333-8333-333333333333"
TARGET_ID = "44444444-4444-4444-8444-444444444444"
INCOMING_REQUEST_ID = "55555555-5555-4555-8555-555555555555"
OUTGOING_REQUEST_ID = "66666666-6666-4666-8666-666666666666"
TEST_EMAIL = "maria@example.test"
TEST_PASSWORD = "Mock-password-123!"
NOW = "2026-10-31T08:00:00Z"


def encoded_json(value):
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


class MockAccountService:
    """A small HTTP contract fixture, not a Supabase server or authorization test."""
    def __init__(self):
        self.calls = []
        self.unhandled = []
        self.sign_in_error = False
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

    def user(self):
        return {
            "id": USER_ID, "aud": "authenticated", "role": "authenticated", "email": TEST_EMAIL,
            "email_confirmed_at": NOW, "phone": "", "confirmed_at": NOW,
            "created_at": NOW, "updated_at": NOW,
            "app_metadata": {"provider": "email", "providers": ["email"]},
            "user_metadata": {"display_name": self.profile["display_name"]},
            "identities": [], "is_anonymous": False,
        }

    def session(self):
        now = int(time.time())
        token = ".".join([
            encoded_json({"alg": "HS256", "typ": "JWT"}),
            encoded_json({"sub": USER_ID, "aud": "authenticated", "role": "authenticated", "email": TEST_EMAIL, "iat": now, "exp": now + 3600}),
            "bW9ja19zaWduYXR1cmVfb25seQ",
        ])
        return {"access_token": token, "token_type": "bearer", "expires_in": 3600, "expires_at": now + 3600, "refresh_token": "mock-refresh-token-only", "user": self.user()}

    def matching(self, path, method=None):
        return [call for call in self.calls if call["path"] == path and (method is None or call["method"] == method)]

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
        headers = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS", "content-type": "application/json", "x-supabase-api-version": "2024-01-01", "access-control-expose-headers": "X-Supabase-Api-Version"}

        def respond(value=None, status=200):
            route.fulfill(status=status, headers=headers, body=json.dumps(value) if value is not None else "")

        def fail(code, message, status=400):
            respond({"code": code, "message": message, "msg": message}, status)

        if request.method == "OPTIONS":
            respond({}, 200)
            return
        if url.path == "/auth/v1/signup":
            respond(self.user())  # Email confirmation is required: no access token/session.
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
                respond({"id": USER_ID})
                return
            identity = query.get("id", [""])[0]
            if identity.startswith("in.("):
                selected_ids = identity.removeprefix("in.(").removesuffix(")").split(",")
                respond([self.other_profiles[id] for id in selected_ids if id in self.other_profiles])
            else:
                respond(self.profile)
            return
        if url.path in ["/rest/v1/friendships", "/rest/v1/friend_requests", "/rest/v1/blocks"]:
            if self.connection_error:
                fail("42P01", "relation friendships does not exist", 404)
            elif url.path.endswith("friendships"):
                respond(self.friendships)
            elif url.path.endswith("friend_requests"):
                respond(self.requests)
            else:
                respond(self.blocks)
            return
        if url.path.startswith("/rest/v1/rpc/"):
            name = url.path.split("/")[-1]
            if self.mutation_error:
                fail("42501", "permission denied", 403)
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
                if body["accept_request"]:
                    self.friendships.append({"id": "accepted-friendship", "user_a": USER_ID, "user_b": target["requester_id"], "created_at": NOW})
            elif name in ["remove_friend", "block_person"]:
                target_id = body["target_id"]
                self.friendships = [f for f in self.friendships if target_id not in [f["user_a"], f["user_b"]]]
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
        self.context.route(f"**{MOCK_HOST}/**", self.service.handle)
        self.page = self.context.new_page()
        self.page.set_default_timeout(9000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], "Uncaught browser errors")
        self.assertEqual(self.service.unhandled, [], "Every fake account request must have an explicit fixture")

    def visit(self, url=ACCOUNT_URL):
        self.page.goto(url)
        expect(self.page.get_by_role("heading", name="Tara, Mika!", exact=True)).to_be_visible()

    def account(self):
        return self.page.get_by_role("dialog", name="Your Yeto account", exact=True)

    def open_account(self):
        self.page.get_by_role("button", name="Open your profile", exact=True).click()
        self.page.get_by_role("dialog").get_by_role("button", name="Set up your account", exact=True).click()
        expect(self.account()).to_be_visible()
        return self.account()

    def sign_in(self):
        self.visit()
        dialog = self.open_account()
        dialog.get_by_label("Email address", exact=True).fill(TEST_EMAIL)
        dialog.get_by_label(re.compile(r"^Password")).fill(TEST_PASSWORD)
        dialog.get_by_role("button", name="Sign in to Yeto", exact=True).click()
        expect(dialog.get_by_role("heading", name="Maria Test", exact=True)).to_be_visible()
        expect(dialog.get_by_label("Display name", exact=True)).to_have_value("Maria Test")
        return dialog

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
        dialog.get_by_role("button", name="Create my Yeto account", exact=True).click()
        expect(dialog.get_by_role("status")).to_contain_text("You aren’t signed in yet")
        expect(dialog.get_by_role("button", name="Sign in to Yeto", exact=True)).to_be_visible()
        expect(dialog.get_by_text("Account connected", exact=True)).to_have_count(0)
        signup = self.service.matching("/auth/v1/signup", "POST")
        self.assertEqual(len(signup), 1)
        self.assertEqual(signup[0]["body"]["data"]["display_name"], "Maria Test")
        self.assertEqual(signup[0]["body"]["email"], TEST_EMAIL)
        self.assertEqual(len(self.service.matching("/rest/v1/profiles")), 0)
        self.assertFalse(self.page.evaluate("Object.values(localStorage).some(v => v.includes('Mock-password-123!'))"))
        self.page.reload()
        dialog = self.open_account()
        expect(dialog.get_by_role("button", name="Sign in to Yeto", exact=True)).to_be_visible()

    def test_03_invalid_credentials_show_actionable_error(self):
        self.service.sign_in_error = True
        self.visit()
        dialog = self.open_account()
        dialog.get_by_label("Email address", exact=True).fill(TEST_EMAIL)
        dialog.get_by_label(re.compile(r"^Password")).fill("Wrong-password-only")
        dialog.get_by_role("button", name="Sign in to Yeto", exact=True).click()
        expect(dialog.get_by_role("alert")).to_contain_text("That email and password don’t match")
        expect(dialog.get_by_text("Account connected", exact=True)).to_have_count(0)
        expect(dialog.get_by_role("button", name="Sign in to Yeto", exact=True)).to_be_enabled()
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
        self.page.get_by_role("button", name="Open your profile", exact=True).click()
        self.page.get_by_role("dialog").get_by_role("button", name="Manage account", exact=True).click()
        dialog = self.account()
        expect(dialog.get_by_label("Display name", exact=True)).to_have_value("Maria Updated")
        dialog.get_by_role("button", name="Sign out", exact=True).click()
        expect(dialog.get_by_role("button", name="Sign in to Yeto", exact=True)).to_be_visible()
        logout = self.service.matching("/auth/v1/logout", "POST")
        self.assertEqual(logout[-1]["query"].get("scope"), ["local"])
        self.page.reload()
        dialog = self.open_account()
        expect(dialog.get_by_role("button", name="Sign in to Yeto", exact=True)).to_be_visible()

    def test_05_profile_error_never_substitutes_demo_identity(self):
        self.service.profile_error = True
        self.visit()
        dialog = self.open_account()
        dialog.get_by_label("Email address", exact=True).fill(TEST_EMAIL)
        dialog.get_by_label(re.compile(r"^Password")).fill(TEST_PASSWORD)
        dialog.get_by_role("button", name="Sign in to Yeto", exact=True).click()
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
        expect(dialog.get_by_role("status")).to_contain_text("If that email has a Yeto account")
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
        demo_state = self.page.evaluate("JSON.parse(localStorage.getItem('yeto-demo-v1'))")
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
