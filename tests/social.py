"""Browser contracts for real feed and Plans, using only intercepted fake HTTP.

Use the two local Vite servers documented in accounts.py, then run:
  python tests/social.py
No hosted accounts, data writes, SQL, or email requests are made.
"""
from datetime import datetime, timedelta, timezone
import json
import re
import unittest
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect
import accounts

POST_ID = "88888888-8888-4888-8888-888888888888"
PLAN_ID = "99999999-9999-4999-8999-999999999999"
HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "content-type": "application/json",
}


class MockSocialService(accounts.MockAccountService):
    """A browser fixture; actual access control is tested with PostgreSQL separately."""
    def __init__(self):
        super().__init__()
        self.social_error = None
        self.social_network_failure = False
        self.hold_snapshot = False
        self.held_snapshots = []
        self.post_serial = 0
        self.comment_serial = 0
        self.plan_serial = 0
        self.social = {accounts.USER_ID: self.empty()}
        self.social[accounts.USER_ID]["posts"] = [{
            "id": POST_ID,
            "author": self.other_profiles[accounts.FRIEND_ID].copy(),
            "body": "A real invitation-only update from Bea.",
            "created_at": accounts.NOW,
            "audience_count": 1,
            "liked_by_me": False,
            "like_count": 0,
            "comments": [],
        }]
        self.social[accounts.USER_ID]["plans"] = [{
            "id": PLAN_ID,
            "owner": self.other_profiles[accounts.FRIEND_ID].copy(),
            "title": "Real lunch invitation",
            "place": "A chosen cafe",
            "starts_at": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
            "kind": "food",
            "created_at": accounts.NOW,
            "invitees": [self.profile.copy()],
            "attendees": [self.other_profiles[accounts.FRIEND_ID].copy()],
        }]
        self.target_posts_by_user = {}
        self.target_plans_by_user = {}
        self.target_error = None

    @staticmethod
    def empty():
        return {"posts": [], "plans": []}

    def current_social(self):
        return self.social.setdefault(self.user_id, self.empty())

    def handle(self, route):
        request = route.request
        url = urlparse(request.url)
        name = url.path.split("/")[-1]
        social_names = {
            "social_snapshot", "create_social_post", "delete_social_post",
            "set_social_like", "add_social_comment", "delete_social_comment",
            "create_social_plan", "delete_social_plan", "set_social_attendance", "activity_target_snapshot",
        }
        if not url.path.startswith("/rest/v1/rpc/") or name not in social_names:
            return super().handle(route)
        if request.method == "OPTIONS":
            route.fulfill(status=200, headers=HEADERS, body="{}")
            return
        body = request.post_data_json or {}
        self.calls.append({"path": url.path, "query": parse_qs(url.query), "method": request.method, "body": body})

        def respond(value=None, status=200):
            route.fulfill(status=status, headers=HEADERS, body=json.dumps(value) if value is not None else "")

        def fail(code, message):
            respond({"code": code, "message": message}, 404 if code == "PGRST202" else 403)

        if name == "social_snapshot":
            if self.social_network_failure:
                route.abort("connectionfailed")
            elif self.social_error:
                fail(self.social_error, "social setup unavailable")
            elif self.hold_snapshot:
                self.held_snapshots.append((route, json.loads(json.dumps(self.current_social()))))
                self.hold_snapshot = False
            else:
                respond(self.current_social())
            return
        if name == "activity_target_snapshot":
            if self.target_error:
                fail(self.target_error, "Target unavailable")
                return
            posts = self.current_social()["posts"] + self.target_posts_by_user.get(self.user_id, [])
            plans = self.current_social()["plans"] + self.target_plans_by_user.get(self.user_id, [])
            respond({"posts": [p for p in posts if p["id"] == body.get("post_id")],
                     "plans": [p for p in plans if p["id"] == body.get("plan_id")]})
            return
        if self.mutation_error:
            fail("42501", "permission denied")
            return
        data = self.current_social()
        if name == "create_social_post":
            self.post_serial += 1
            post_id = f"own-post-{self.post_serial}"
            data["posts"].insert(0, {
                "id": post_id, "author": self.profile.copy(), "body": body["body_text"],
                "created_at": datetime.now(timezone.utc).isoformat(),
                "audience_count": len(body["viewer_ids"]), "liked_by_me": False,
                "like_count": 0, "comments": [],
            })
            respond(post_id)
        elif name == "delete_social_post":
            data["posts"] = [p for p in data["posts"] if p["id"] != body["post_id"]]
            respond()
        elif name == "set_social_like":
            post = next(p for p in data["posts"] if p["id"] == body["post_id"])
            if post["liked_by_me"] != body["liked"]:
                post["like_count"] += 1 if body["liked"] else -1
            post["liked_by_me"] = body["liked"]
            respond()
        elif name == "add_social_comment":
            self.comment_serial += 1
            comment_id = f"own-comment-{self.comment_serial}"
            post = next(p for p in data["posts"] if p["id"] == body["post_id"])
            post["comments"].append({"id": comment_id, "author": self.profile.copy(), "body": body["body_text"], "created_at": datetime.now(timezone.utc).isoformat()})
            respond(comment_id)
        elif name == "delete_social_comment":
            for post in data["posts"]:
                post["comments"] = [c for c in post["comments"] if c["id"] != body["comment_id"]]
            respond()
        elif name == "create_social_plan":
            self.plan_serial += 1
            plan_id = f"own-plan-{self.plan_serial}"
            data["plans"].insert(0, {
                "id": plan_id, "owner": self.profile.copy(), "title": body["plan_title"],
                "place": body["plan_place"], "starts_at": body["plan_starts_at"],
                "kind": body["plan_kind"], "created_at": datetime.now(timezone.utc).isoformat(),
                "invitees": [self.other_profiles[p].copy() for p in body["invitee_ids"]],
                "attendees": [self.profile.copy()],
            })
            respond(plan_id)
        elif name == "delete_social_plan":
            data["plans"] = [p for p in data["plans"] if p["id"] != body["plan_id"]]
            respond()
        elif name == "set_social_attendance":
            plan = next(p for p in data["plans"] if p["id"] == body["plan_id"])
            plan["attendees"] = [p for p in plan["attendees"] if p["id"] != self.user_id]
            if body["going"]:
                plan["attendees"].append(self.profile.copy())
            respond()


class SocialBrowserTests(unittest.TestCase):
    setUpClass = accounts.AccountIntegrationTests.__dict__["setUpClass"]
    tearDownClass = accounts.AccountIntegrationTests.__dict__["tearDownClass"]
    tearDown = accounts.AccountIntegrationTests.tearDown
    visit = accounts.AccountIntegrationTests.visit
    account = accounts.AccountIntegrationTests.account
    open_account = accounts.AccountIntegrationTests.open_account
    sign_in = accounts.AccountIntegrationTests.sign_in
    submit_sign_in = accounts.AccountIntegrationTests.submit_sign_in
    close_account = accounts.AccountIntegrationTests.close_account
    demo_state = accounts.AccountIntegrationTests.demo_state

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 1050})
        self.service = MockSocialService()
        self.errors = []
        self.unexpected_remote_hosts = []
        allowed_hosts = {urlparse(accounts.DEMO_URL).hostname, urlparse(accounts.ACCOUNT_URL).hostname}

        def local_only(route):
            host = urlparse(route.request.url).hostname
            if host in allowed_hosts:
                route.continue_()
            else:
                self.unexpected_remote_hosts.append(host)
                route.abort()

        self.context.route("**/*", local_only)
        self.context.route(f"**{accounts.MOCK_HOST}/**", self.service.handle)
        self.page = self.context.new_page()
        self.page.set_default_timeout(9000)
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def sign_in_feed(self):
        self.sign_in()
        self.close_account()
        feed = self.page.get_by_role("region", name="Real feed", exact=True)
        expect(feed).to_be_visible()
        return feed

    def main_plans(self):
        self.page.get_by_role("navigation", name="Main navigation", exact=True).get_by_role("button", name=re.compile(r"^Plans")).click()
        return self.page.get_by_role("main")

    def snapshot_calls(self):
        return self.service.matching("/rest/v1/rpc/social_snapshot", "POST")

    def rpc_body(self, name):
        return self.service.matching(f"/rest/v1/rpc/{name}", "POST")[-1]["body"]

    def test_01_feed_uses_real_people_private_default_and_selected_friends(self):
        feed = self.sign_in_feed()
        expect(feed.get_by_text("A real invitation-only update from Bea.", exact=True)).to_be_visible()
        expect(feed.get_by_text("Home safely!", exact=True)).to_have_count(0)
        expect(feed.get_by_text("Coffee in BGC?", exact=True)).to_have_count(0)
        update = feed.get_by_role("textbox", name="Your update", exact=True)
        update.fill("My private real update")
        expect(feed.get_by_text(re.compile(r"^Only me\."))).to_be_visible()
        checkbox = feed.get_by_role("checkbox", name="Test Bea (@bea_real_test)", exact=True)
        expect(checkbox).not_to_be_checked()
        expect(feed.get_by_role("checkbox", name=re.compile("Test Ana"))).to_have_count(0)
        feed.get_by_role("button", name="Publish update", exact=True).click()
        expect(feed.get_by_text("My private real update", exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("create_social_post"), {"body_text": "My private real update", "viewer_ids": []})
        feed.get_by_role("textbox", name="Your update", exact=True).fill("Shared with one chosen friend")
        feed.get_by_role("checkbox", name="Test Bea (@bea_real_test)", exact=True).check()
        feed.get_by_role("button", name="Publish update", exact=True).click()
        expect(feed.get_by_text("Shared with one chosen friend", exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("create_social_post"), {"body_text": "Shared with one chosen friend", "viewer_ids": [accounts.FRIEND_ID]})
        self.assertIsNone(self.demo_state(accounts.USER_ID)["sharing"])
        self.assertEqual(self.demo_state(accounts.USER_ID)["checkIns"], [], "Real posts must not be copied into browser demo storage")

    def test_02_feed_reactions_comments_delete_and_reload_use_rpc(self):
        feed = self.sign_in_feed()
        article = feed.get_by_role("article", name="Update by Test Bea", exact=True)
        article.get_by_role("button", name="Like update by Test Bea", exact=True).click()
        expect(article.get_by_role("button", name="Unlike update by Test Bea", exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("set_social_like"), {"post_id": POST_ID, "liked": True})
        article.get_by_role("button", name="Unlike update by Test Bea", exact=True).click()
        expect(article.get_by_role("button", name="Like update by Test Bea", exact=True)).to_be_visible()
        article.get_by_role("button", name="Comments on update by Test Bea", exact=True).click()
        article.get_by_label("Comment on update by Test Bea", exact=True).fill("A thoughtful real comment")
        article.get_by_role("button", name="Send comment", exact=True).click()
        expect(article.get_by_text("A thoughtful real comment", exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("add_social_comment"), {"post_id": POST_ID, "body_text": "A thoughtful real comment"})
        self.page.reload()
        feed = self.page.get_by_role("region", name="Real feed", exact=True)
        article = feed.get_by_role("article", name="Update by Test Bea", exact=True)
        article.get_by_role("button", name="Comments on update by Test Bea", exact=True).click()
        expect(article.get_by_text("A thoughtful real comment", exact=True)).to_be_visible()
        article.get_by_role("button", name="Delete your comment: A thoughtful real comment", exact=True).click()
        self.page.get_by_role("dialog", name="Delete this comment?", exact=True).get_by_role("button", name="Delete comment", exact=True).click()
        expect(article.get_by_text("A thoughtful real comment", exact=True)).to_have_count(0)
        self.assertEqual(self.rpc_body("delete_social_comment"), {"comment_id": "own-comment-1"})
        expect(article.get_by_role("button", name="Delete your update", exact=True)).to_have_count(0)
        feed.get_by_role("textbox", name="Your update", exact=True).fill("Delete this own update")
        feed.get_by_role("button", name="Publish update", exact=True).click()
        own = feed.get_by_role("article", name="Update by Maria Test", exact=True)
        own.get_by_role("button", name="Delete your update", exact=True).click()
        confirm = self.page.get_by_role("dialog", name="Delete this update?", exact=True)
        confirm.get_by_role("button", name="Delete update", exact=True).click()
        expect(feed.get_by_text("Delete this own update", exact=True)).to_have_count(0)
        self.assertEqual(self.rpc_body("delete_social_post"), {"post_id": "own-post-1"})

    def test_03_missing_migration_and_network_errors_never_show_sample_fallback(self):
        self.service.social_error = "PGRST202"
        feed = self.sign_in_feed()
        expect(feed.get_by_text("Feed and Plans setup is pending", exact=True)).to_be_visible()
        expect(self.page.get_by_role("main").get_by_text("Home safely!", exact=True)).to_have_count(0)
        self.assertEqual(self.service.matching("/rest/v1/rpc/create_social_post", "POST"), [])
        self.service.social_error = None
        feed.get_by_role("button", name="Refresh feed and plans", exact=True).click()
        expect(feed.get_by_text("A real invitation-only update from Bea.", exact=True)).to_be_visible()
        self.service.social_network_failure = True
        feed.get_by_role("button", name="Refresh feed and plans", exact=True).click()
        expect(feed.get_by_role("alert")).to_be_visible()
        expect(feed.get_by_text("A real invitation-only update from Bea.", exact=True)).to_have_count(0)
        expect(feed.get_by_text("Feed and Plans setup is pending", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("main").get_by_text("Home safely!", exact=True)).to_have_count(0)

    def test_04_account_switch_discards_real_content_and_unsent_drafts(self):
        feed = self.sign_in_feed()
        feed.get_by_role("textbox", name="Your update", exact=True).fill("Never publish this first account draft")
        self.open_account().get_by_role("button", name="Sign out", exact=True).click()
        expect(self.account().get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        self.service.switch_user(accounts.SECOND_USER_ID, "Luna Other", "luna_other", "luna@example.test")
        self.submit_sign_in(self.account())
        self.close_account()
        feed = self.page.get_by_role("region", name="Real feed", exact=True)
        expect(feed.get_by_text("A real invitation-only update from Bea.", exact=True)).to_have_count(0)
        expect(feed.get_by_text("Never publish this first account draft", exact=True)).to_have_count(0)
        expect(feed.get_by_role("textbox", name="Your update", exact=True)).to_have_value("")
        self.assertEqual(self.service.matching("/rest/v1/rpc/create_social_post", "POST"), [])
        self.assertIsNone(self.demo_state(accounts.SECOND_USER_ID)["sharing"])

    def test_05_plans_create_selected_invites_rsvp_and_cancel_use_real_data(self):
        self.sign_in_feed()
        main = self.main_plans()
        invited = main.get_by_role("article").filter(has=self.page.get_by_role("heading", name="Real lunch invitation", exact=True))
        expect(invited).to_be_visible()
        expect(main.get_by_text("Coffee in BGC?", exact=True)).to_have_count(0)
        invited.get_by_role("button", name="Join Real lunch invitation", exact=True).click()
        expect(invited.get_by_role("button", name="Leave Real lunch invitation", exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("set_social_attendance"), {"plan_id": PLAN_ID, "going": True})
        expect(invited.get_by_label("People going to Real lunch invitation", exact=True)).to_contain_text("Maria Test")
        invited.get_by_role("button", name="Leave Real lunch invitation", exact=True).click()
        expect(invited.get_by_role("button", name="Join Real lunch invitation", exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("set_social_attendance"), {"plan_id": PLAN_ID, "going": False})
        expect(invited.get_by_role("button", name="Cancel plan", exact=True)).to_have_count(0)
        main.get_by_role("button", name="Make a plan", exact=True).click()
        form = main.get_by_role("form", name="Create a real plan", exact=True)
        form.get_by_label("Plan title", exact=True).fill("A real future meetup")
        form.get_by_label("Meeting place", exact=True).fill("Our chosen cafe")
        future = (datetime.now(timezone.utc) + timedelta(days=3)).astimezone(timezone(timedelta(hours=8))).replace(hour=15, minute=30, second=0, microsecond=0)
        form.get_by_label("Date", exact=True).fill(future.strftime("%Y-%m-%d"))
        form.get_by_label("Time (Philippines)", exact=True).fill("15:30")
        form.get_by_role("combobox").select_option("coffee")
        expect(form.get_by_role("checkbox", name="Test Bea (@bea_real_test)", exact=True)).not_to_be_checked()
        expect(form.get_by_role("checkbox", name=re.compile("Test Ana"))).to_have_count(0)
        form.get_by_role("checkbox", name="Test Bea (@bea_real_test)", exact=True).check()
        form.get_by_role("button", name="Save plan", exact=True).click()
        own = main.get_by_role("article").filter(has=self.page.get_by_role("heading", name="A real future meetup", exact=True))
        expect(own).to_be_visible()
        body = self.rpc_body("create_social_plan")
        self.assertEqual(body["invitee_ids"], [accounts.FRIEND_ID])
        self.assertEqual(body["plan_title"], "A real future meetup")
        self.assertEqual(body["plan_place"], "Our chosen cafe")
        self.assertEqual(datetime.fromisoformat(body["plan_starts_at"].replace("Z", "+00:00")), future)
        expect(own.get_by_label("People going to A real future meetup", exact=True)).to_contain_text("Maria Test")
        main.get_by_role("button", name="My plans", exact=True).click()
        expect(own).to_be_visible()
        expect(main.get_by_role("heading", name="Real lunch invitation", exact=True)).to_have_count(0)
        own.get_by_role("button", name="Cancel plan", exact=True).click()
        confirm = self.page.get_by_role("dialog", name="Cancel A real future meetup?", exact=True)
        confirm.get_by_role("button", name="Yes, cancel plan", exact=True).click()
        expect(main.get_by_role("heading", name="A real future meetup", exact=True)).to_have_count(0)
        self.assertEqual(self.rpc_body("delete_social_plan"), {"plan_id": "own-plan-1"})
        self.assertIsNone(self.demo_state(accounts.USER_ID)["sharing"])
        self.assertEqual(len(self.demo_state(accounts.USER_ID)["plans"]), 3, "Real plans must not overwrite retained demo plans")

    def test_06_late_old_account_social_snapshot_never_leaks_into_new_account(self):
        feed = self.sign_in_feed()
        expect(feed.get_by_text("A real invitation-only update from Bea.", exact=True)).to_be_visible()
        self.service.hold_snapshot = True
        with self.page.expect_request(f"**{accounts.MOCK_HOST}/rest/v1/rpc/social_snapshot"):
            feed.get_by_role("button", name="Refresh feed and plans", exact=True).click()
        self.open_account().get_by_role("button", name="Sign out", exact=True).click()
        expect(self.account().get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        self.service.switch_user(accounts.SECOND_USER_ID, "Luna Other", "luna_other", "luna@example.test")
        self.submit_sign_in(self.account())
        self.close_account()
        feed = self.page.get_by_role("region", name="Real feed", exact=True)
        expect(feed.get_by_text("A real invitation-only update from Bea.", exact=True)).to_have_count(0)
        self.assertEqual(len(self.service.held_snapshots), 1)
        self.page.evaluate("""() => {
            window.__oldSocialLeaked = false;
            new MutationObserver(() => {
                if (document.querySelector('main')?.textContent.includes('A real invitation-only update from Bea.')) {
                    window.__oldSocialLeaked = true;
                }
            }).observe(document.querySelector('main'), {subtree: true, childList: true, characterData: true});
        }""")
        route, old = self.service.held_snapshots[0]
        route.fulfill(status=200, headers=HEADERS, body=json.dumps(old))
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        self.assertFalse(self.page.evaluate("window.__oldSocialLeaked"))
        expect(feed.get_by_text("A real invitation-only update from Bea.", exact=True)).to_have_count(0)
        self.assertIsNone(self.demo_state(accounts.SECOND_USER_ID)["sharing"])

    def test_07_failed_save_keeps_draft_and_private_plan_has_no_invitees(self):
        feed = self.sign_in_feed()
        feed.get_by_role("textbox", name="Your update", exact=True).fill("Keep my failed update draft")
        self.service.mutation_error = True
        feed.get_by_role("button", name="Publish update", exact=True).click()
        expect(feed.get_by_role("alert")).to_be_visible()
        self.assertFalse(any(post["body"] == "Keep my failed update draft" for post in self.service.current_social()["posts"]))
        self.service.mutation_error = False
        feed.get_by_role("button", name="Refresh feed and plans", exact=True).click()
        expect(feed.get_by_role("textbox", name="Your update", exact=True)).to_have_value("Keep my failed update draft")
        feed.get_by_role("button", name="Publish update", exact=True).click()
        expect(feed.get_by_text("Keep my failed update draft", exact=True)).to_be_visible()
        self.assertFalse(self.page.evaluate("Object.values(localStorage).some(value => value.includes('Keep my failed update draft'))"), "Real post contents must not be saved to demo/browser storage")
        main = self.main_plans()
        main.get_by_role("button", name="Make a plan", exact=True).click()
        form = main.get_by_role("form", name="Create a real plan", exact=True)
        form.get_by_label("Plan title", exact=True).fill("A private real plan")
        form.get_by_label("Meeting place", exact=True).fill("My chosen meeting place")
        future = (datetime.now(timezone.utc) + timedelta(days=3)).astimezone(timezone(timedelta(hours=8)))
        form.get_by_label("Date", exact=True).fill(future.strftime("%Y-%m-%d"))
        form.get_by_label("Time (Philippines)", exact=True).fill("16:00")
        form.get_by_role("button", name="Save plan", exact=True).click()
        own = main.get_by_role("article").filter(has=self.page.get_by_role("heading", name="A private real plan", exact=True))
        expect(own).to_contain_text("Private plan · only you")
        self.assertEqual(self.rpc_body("create_social_plan")["invitee_ids"], [])
        self.assertIsNone(self.demo_state(accounts.USER_ID)["sharing"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
