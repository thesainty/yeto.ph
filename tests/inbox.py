"""Activity inbox and audience-review browser contracts using fake HTTP only.

Use the two local servers described in accounts.py, then run:
  python tests/inbox.py
All account traffic is intercepted. PostgreSQL access rules are tested in the
separate inbox-database.test.mjs suite; no hosted data or emails are touched.
"""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import time
import unittest

from playwright.sync_api import expect
import accounts
import social

OLD_POST = "cccccccc-cccc-4ccc-8ccc-000000000001"
OLD_PLAN = "cccccccc-cccc-4ccc-8ccc-000000000002"
COMMENT = "dddddddd-dddd-4ddd-8ddd-000000000001"


class InboxBrowserTests(unittest.TestCase):
    setUpClass = accounts.AccountIntegrationTests.__dict__["setUpClass"]
    tearDownClass = accounts.AccountIntegrationTests.__dict__["tearDownClass"]
    setUp = social.SocialBrowserTests.setUp
    tearDown = accounts.AccountIntegrationTests.tearDown
    visit = accounts.AccountIntegrationTests.visit
    account = accounts.AccountIntegrationTests.account
    open_account = accounts.AccountIntegrationTests.open_account
    sign_in = accounts.AccountIntegrationTests.sign_in
    submit_sign_in = accounts.AccountIntegrationTests.submit_sign_in
    close_account = accounts.AccountIntegrationTests.close_account
    sign_in_feed = social.SocialBrowserTests.sign_in_feed
    main_plans = social.SocialBrowserTests.main_plans
    rpc_body = social.SocialBrowserTests.rpc_body

    def inbox(self):
        self.page.get_by_role("button", name="Open notifications", exact=True).click()
        dialog = self.page.get_by_role("dialog", name="Activity inbox", exact=True)
        expect(dialog).to_be_visible()
        return dialog

    def seed_post(self, post_id=OLD_POST):
        post = {
            "id": post_id, "author": self.service.profile.copy(), "body": "An older update reached from the inbox",
            "created_at": accounts.NOW, "audience_count": 1, "liked_by_me": False, "like_count": 1,
            "comments": [{"id": COMMENT, "author": self.service.other_profiles[accounts.FRIEND_ID].copy(),
                          "body": "A comment on the older update", "created_at": accounts.NOW}],
        }
        self.service.target_posts_by_user.setdefault(self.service.user_id, []).append(post)
        return post

    def seed_plan(self, plan_id=OLD_PLAN):
        plan = {
            "id": plan_id, "owner": self.service.profile.copy(), "title": "An older plan reached from the inbox",
            "place": "A chosen café", "starts_at": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
            "kind": "coffee", "created_at": accounts.NOW,
            "invitees": [self.service.other_profiles[accounts.FRIEND_ID].copy()],
            "attendees": [self.service.profile.copy(), self.service.other_profiles[accounts.FRIEND_ID].copy()],
        }
        self.service.target_plans_by_user.setdefault(self.service.user_id, []).append(plan)
        return plan

    def add_friend(self):
        self.service.friendships.append({"id": "friendship-ana", "user_a": self.service.user_id,
                                         "user_b": accounts.INCOMING_ID, "created_at": accounts.NOW})

    def refresh_inbox(self, dialog):
        dialog.get_by_role("button", name="Refresh activity", exact=True).click()

    def held(self, queue):
        deadline = time.monotonic() + 5
        while not queue and time.monotonic() < deadline:
            self.page.wait_for_timeout(10)
        self.assertTrue(queue, "Expected intercepted request was never queued")
        return queue.pop()

    def settle_screenshot(self):
        self.page.evaluate("""async () => {
            await Promise.all(document.getAnimations().filter(animation =>
                animation.effect?.getComputedTiming().iterations !== Infinity
            ).map(animation => animation.finished.catch(() => {})));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }""")

    def test_01_read_state_badge_and_exact_visible_marking_persist_to_account(self):
        first = self.service.add_activity("post_like", post_id=social.POST_ID)
        second = self.service.add_activity("post_comment", post_id=social.POST_ID, comment_id=COMMENT)
        self.sign_in_feed()
        bell = self.page.get_by_role("button", name="Open notifications", exact=True)
        expect(bell).to_contain_text("2")
        dialog = self.inbox()
        expect(dialog.locator(".activity-count")).to_have_text("2 unread")
        Path("test-results").mkdir(exist_ok=True)
        self.settle_screenshot()
        self.page.screenshot(path="test-results/inbox-desktop.png", full_page=True)
        self.assertEqual(self.service.matching("/rest/v1/rpc/mark_activity_read", "POST"), [], "Opening must not acknowledge unseen activity")
        self.service.hold_inbox_mark = True
        dialog.get_by_role("button", name="Mark visible as read", exact=True).click()
        pending, owner, ids = self.held(self.service.held_inbox_marks)
        self.assertCountEqual(ids, [first["id"], second["id"]])
        newer = self.service.add_activity("friend_request", actor_id=accounts.INCOMING_ID, request_id=accounts.INCOMING_REQUEST_ID)
        for item in self.service.inbox_by_user[owner]:
            if item["id"] in ids:
                item["read_at"] = accounts.NOW
        pending.fulfill(status=200, headers=social.HEADERS, body="null")
        expect(dialog.locator(".activity-count")).to_have_text("1 unread")
        expect(dialog.get_by_role("button", name="Unread: Test Ana sent you a friend request", exact=True)).to_be_visible()
        self.assertIsNone(newer["read_at"], "New activity arriving during an acknowledgement must remain unread")
        self.page.reload()
        dialog = self.inbox()
        expect(dialog.locator(".activity-count")).to_have_text("1 unread")
        expect(dialog.get_by_role("button", name="Read: Test Bea liked your update", exact=True)).to_be_visible()
        self.assertFalse(self.page.evaluate("Object.values(localStorage).some(value => value.includes('post_like') || value.includes('post_comment'))"), "Inbox records must not enter demo/browser storage")

    def test_02_post_links_fetch_exact_old_target_and_focus_it(self):
        self.seed_post()
        item = self.service.add_activity("post_comment", post_id=OLD_POST, comment_id=COMMENT)
        self.sign_in_feed()
        expect(self.page.get_by_text("An older update reached from the inbox", exact=True)).to_have_count(0)
        dialog = self.inbox()
        dialog.get_by_role("button", name="Unread: Test Bea commented on your update", exact=True).click()
        expect(dialog).to_have_count(0)
        card = self.page.locator(f"#activity-post-{OLD_POST}")
        expect(card).to_be_visible()
        expect(card).to_be_focused()
        expect(card).to_contain_text("An older update reached from the inbox")
        self.assertEqual(self.rpc_body("activity_target_snapshot"), {"post_id": OLD_POST, "plan_id": None})
        self.assertEqual(self.rpc_body("mark_activity_read"), {"activity_ids": [item["id"]]})
        self.assertIsNotNone(item["read_at"])
        expect(self.page.get_by_text("Home safely!", exact=True)).to_have_count(0)

    def test_03_plan_invitation_and_rsvp_actions_link_to_actual_plans(self):
        self.add_friend()
        old_plan = self.seed_plan()
        self.service.add_activity("plan_invite", plan_id=social.PLAN_ID, plan_title="Real lunch invitation")
        self.service.add_activity("plan_rsvp", plan_id=OLD_PLAN, plan_title=old_plan["title"], rsvp_going=True)
        self.service.add_activity("plan_rsvp", actor_id=accounts.INCOMING_ID, plan_id=OLD_PLAN, plan_title=old_plan["title"], rsvp_going=False)
        self.sign_in_feed()
        dialog = self.inbox()
        expect(dialog.get_by_role("button", name="Unread: Test Ana left An older plan reached from the inbox", exact=True)).to_be_visible()
        dialog.get_by_role("button", name="Unread: Test Bea joined An older plan reached from the inbox", exact=True).click()
        card = self.page.locator(f"#activity-plan-{OLD_PLAN}")
        expect(card).to_be_visible()
        expect(card).to_be_focused()
        self.assertEqual(self.rpc_body("activity_target_snapshot"), {"post_id": None, "plan_id": OLD_PLAN})
        self.page.get_by_role("main").get_by_role("button", name="My plans", exact=True).click()
        expect(self.page.get_by_role("heading", name="Real lunch invitation", exact=True)).to_have_count(0)
        dialog = self.inbox()
        dialog.get_by_role("button", name="Unread: Test Bea invited you to Real lunch invitation", exact=True).click()
        expect(self.page.locator(f"#activity-plan-{social.PLAN_ID}")).to_be_focused()
        self.assertEqual(self.rpc_body("activity_target_snapshot"), {"post_id": None, "plan_id": social.PLAN_ID})
        # An explicit inbox link reveals its target, but later background reads
        # must respect the filter the person chooses after opening that target.
        my_plans = self.page.get_by_role("main").get_by_role("button", name="My plans", exact=True)
        my_plans.click()
        with self.page.expect_response(f"**{accounts.MOCK_HOST}/rest/v1/rpc/activity_target_snapshot") as revalidation:
            self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        self.assertEqual(revalidation.value.json()["plans"][0]["id"], social.PLAN_ID)
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        expect(my_plans).to_have_attribute("aria-pressed", "true")
        expect(self.page.get_by_role("heading", name="Real lunch invitation", exact=True)).to_have_count(0)

    def test_04_friend_request_and_acceptance_copy_link_to_real_friends(self):
        self.service.add_activity("friend_request", actor_id=accounts.INCOMING_ID, request_id=accounts.INCOMING_REQUEST_ID)
        self.service.add_activity("friend_accepted", actor_id=accounts.FRIEND_ID, request_id=accounts.OUTGOING_REQUEST_ID)
        self.sign_in_feed()
        dialog = self.inbox()
        expect(dialog.get_by_role("button", name="Unread: Test Bea accepted your friend request", exact=True)).to_be_visible()
        dialog.get_by_role("button", name="Unread: Test Ana sent you a friend request", exact=True).click()
        expect(dialog).to_have_count(0)
        panel = self.page.get_by_role("main").locator(".connections-panel")
        expect(panel).to_be_visible()
        expect(panel.get_by_text("Test Ana", exact=True)).to_be_visible()
        expect(self.page.get_by_text("Ana wants to connect", exact=True)).to_have_count(0)

    def test_05_missing_migration_failure_and_deleted_target_never_fallback_to_samples(self):
        self.service.inbox_error = "PGRST202"
        self.sign_in_feed()
        dialog = self.inbox()
        expect(dialog.get_by_role("alert")).to_contain_text("Your activity inbox is coming soon")
        dialog.get_by_role("button", name="Open friend requests", exact=True).click()
        expect(self.page.get_by_role("main").locator(".connections-panel")).to_be_visible()
        self.service.inbox_error = None
        item = self.service.add_activity("post_like", post_id=OLD_POST)
        dialog = self.inbox()
        self.refresh_inbox(dialog)
        expect(dialog.get_by_role("button", name="Unread: Test Bea liked your update", exact=True)).to_be_visible()
        self.service.inbox_mutation_error = True
        dialog.get_by_role("button", name="Unread: Test Bea liked your update", exact=True).click()
        expect(dialog.get_by_role("alert").first).to_be_visible()
        self.assertIsNone(item["read_at"])
        expect(dialog).to_be_visible()
        self.service.inbox_mutation_error = False
        self.refresh_inbox(dialog)
        expect(dialog.get_by_role("button", name="Unread: Test Bea liked your update", exact=True)).to_be_visible()
        dialog.get_by_role("button", name="Unread: Test Bea liked your update", exact=True).click()
        expect(self.page.locator(f"#activity-post-{OLD_POST}")).to_have_count(0)
        expect(self.page.get_by_text(re.compile(r"no longer available|no longer have access", re.I))).to_be_visible()
        expect(self.page.get_by_text("Home safely!", exact=True)).to_have_count(0)

    def test_06_late_account_snapshot_does_not_leak(self):
        self.service.add_activity("post_like", post_id=social.POST_ID)
        self.sign_in_feed()
        dialog = self.inbox()
        self.service.hold_inbox_snapshot = True
        self.refresh_inbox(dialog)
        pending, old_snapshot = self.held(self.service.held_inbox_snapshots)
        dialog.get_by_role("button", name="Close dialog", exact=True).click()
        self.open_account().get_by_role("button", name="Sign out", exact=True).click()
        expect(self.account().get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        self.service.switch_user(accounts.SECOND_USER_ID, "Luna Other", "luna_other", "luna@example.test")
        self.submit_sign_in(self.account())
        self.close_account()
        pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(old_snapshot))
        dialog = self.inbox()
        expect(dialog.get_by_text("You’re all caught up", exact=True)).to_be_visible()
        expect(dialog.get_by_text("Test Bea liked your update", exact=True)).to_have_count(0)
        self.assertEqual(self.service.matching("/rest/v1/rpc/mark_activity_read", "POST"), [])

    def test_07_relationship_revocation_and_failed_refresh_hide_old_activity(self):
        self.service.add_activity("post_like", post_id=social.POST_ID)
        self.sign_in_feed()
        dialog = self.inbox()
        expect(dialog.get_by_text("Test Bea liked your update", exact=True)).to_be_visible()
        self.service.inbox_network_failure = True
        self.refresh_inbox(dialog)
        expect(dialog.get_by_role("alert")).to_be_visible()
        expect(dialog.get_by_text("Test Bea liked your update", exact=True)).to_have_count(0)
        self.service.inbox_network_failure = False
        self.service.inbox_by_user[accounts.USER_ID] = []
        self.service.friendships = []
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(dialog.get_by_text("You’re all caught up", exact=True)).to_be_visible()
        expect(dialog.get_by_text("Test Bea liked your update", exact=True)).to_have_count(0)

    def test_08_audience_review_names_remain_exact_through_search_and_circle_edits(self):
        self.add_friend()
        circle = {"id": "aaaaaaaa-aaaa-4aaa-8aaa-000000000099", "name": "Pamilya", "member_ids": [accounts.FRIEND_ID]}
        self.service.current_circles().append(circle)
        feed = self.sign_in_feed()
        review = feed.get_by_role("region", name="Audience review", exact=True)
        expect(review.get_by_text("Only me", exact=True)).to_be_visible()
        expect(review).to_contain_text("This update is visible only to you.")
        picker = feed.locator(".social-recipient-picker")
        picker.get_by_role("button", name="Use Pamilya", exact=True).click()
        expect(review.get_by_text("Sharing with 1 friend", exact=True)).to_be_visible()
        review.locator("summary").press("Enter")
        expect(review.get_by_role("list", name="Selected recipients", exact=True)).to_contain_text("Test Bea")
        expect(review).to_contain_text("@bea_real_test")
        Path("test-results").mkdir(exist_ok=True)
        self.page.screenshot(path="test-results/audience-review-desktop.png", full_page=True)
        picker.get_by_role("searchbox", name="Search friends", exact=True).fill("ana")
        expect(picker.get_by_role("checkbox")).to_have_count(1)
        expect(review.get_by_text("Test Bea", exact=True)).to_be_visible()
        circle["member_ids"].append(accounts.INCOMING_ID)
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(review.get_by_text("Sharing with 1 friend", exact=True)).to_be_visible()
        expect(review.get_by_text("Test Ana", exact=True)).to_have_count(0)
        feed.get_by_role("textbox", name="Your update", exact=True).fill("Exactly the reviewed recipients")
        feed.get_by_role("button", name="Publish update", exact=True).click()
        expect(feed.get_by_text("Exactly the reviewed recipients", exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("create_social_post")["viewer_ids"], [accounts.FRIEND_ID])
        expect(review.get_by_text("Only me", exact=True)).to_be_visible()
        main = self.main_plans()
        main.get_by_role("button", name="Make a plan", exact=True).click()
        form = main.get_by_role("form", name="Create a real plan", exact=True)
        plan_review = form.get_by_role("region", name="Audience review", exact=True)
        expect(plan_review.get_by_text("Only me", exact=True)).to_be_visible()
        form.locator(".social-recipient-picker").get_by_role("button", name="All current friends", exact=True).click()
        expect(plan_review.get_by_text("Inviting 2 friends", exact=True)).to_be_visible()
        plan_review.locator("summary").click()
        expect(plan_review.get_by_text("Test Bea", exact=True)).to_be_visible()
        expect(plan_review.get_by_text("Test Ana", exact=True)).to_be_visible()

    def test_09_mobile_inbox_keyboard_and_audience_review_fit(self):
        self.page.emulate_media(reduced_motion="reduce")
        self.seed_post()
        self.service.add_activity("post_like", post_id=OLD_POST)
        feed = self.sign_in_feed()
        for width in [375, 320]:
            with self.subTest(width=width):
                self.page.set_viewport_size({"width": width, "height": 812})
                dialog = self.inbox()
                expect(dialog.get_by_role("button", name="Close dialog", exact=True)).to_be_focused()
                expect(dialog.get_by_text("Test Bea liked your update", exact=True)).to_be_visible()
                dimensions = self.page.evaluate("({width:innerWidth, scroll:document.documentElement.scrollWidth})")
                self.assertLessEqual(dimensions["scroll"], dimensions["width"])
                self.assertLessEqual(dialog.bounding_box()["width"], width)
                Path("test-results").mkdir(exist_ok=True)
                self.settle_screenshot()
                self.page.screenshot(path=f"test-results/inbox-mobile-{width}.png", full_page=True)
                self.page.keyboard.press("Escape")
                expect(dialog).to_have_count(0)
                expect(self.page.get_by_role("button", name="Open notifications", exact=True)).to_be_focused()
                picker = feed.locator(".social-recipient-picker")
                picker.get_by_role("button", name="All current friends", exact=True).click()
                review = feed.get_by_role("region", name="Audience review", exact=True)
                summary = review.locator("summary")
                if review.locator("details").get_attribute("open") is None:
                    summary.press("Enter")
                expect(review.get_by_text("Test Bea", exact=True)).to_be_visible()
                dimensions = self.page.evaluate("({width:innerWidth, scroll:document.documentElement.scrollWidth})")
                self.assertLessEqual(dimensions["scroll"], dimensions["width"])
                self.page.screenshot(path=f"test-results/audience-review-mobile-{width}.png", full_page=True)

    def test_10_late_read_write_does_not_acknowledge_another_accounts_activity(self):
        old_item = self.service.add_activity("friend_accepted", request_id=accounts.OUTGOING_REQUEST_ID)
        self.sign_in_feed()
        dialog = self.inbox()
        self.service.hold_inbox_mark = True
        dialog.get_by_role("button", name="Mark visible as read", exact=True).click()
        pending, owner, ids = self.held(self.service.held_inbox_marks)
        dialog.get_by_role("button", name="Close dialog", exact=True).click()
        self.open_account().get_by_role("button", name="Sign out", exact=True).click()
        expect(self.account().get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        self.service.switch_user(accounts.SECOND_USER_ID, "Luna Other", "luna_other", "luna@example.test")
        new_item = self.service.add_activity("plan_invite", plan_id=social.PLAN_ID, plan_title="Luna’s private invitation")
        self.submit_sign_in(self.account())
        self.close_account()
        for item in self.service.inbox_by_user[owner]:
            if item["id"] in ids:
                item["read_at"] = accounts.NOW
        pending.fulfill(status=200, headers=social.HEADERS, body="null")
        dialog = self.inbox()
        expect(dialog.locator(".activity-count")).to_have_text("1 unread")
        expect(dialog.get_by_role("button", name="Unread: Test Bea invited you to Luna’s private invitation", exact=True)).to_be_visible()
        expect(dialog.get_by_text("Test Bea accepted your friend request", exact=True)).to_have_count(0)
        self.assertIsNotNone(old_item["read_at"])
        self.assertIsNone(new_item["read_at"])

    def test_11_mark_visible_caps_at_100_and_leaves_older_activity_unread(self):
        items = [self.service.add_activity("post_comment", post_id=social.POST_ID,
                    comment_id=f"dddddddd-dddd-4ddd-8ddd-{number + 1:012d}") for number in range(101)]
        self.sign_in_feed()
        dialog = self.inbox()
        expect(dialog.get_by_role("list", name="Recent activity", exact=True).get_by_role("button")).to_have_count(100)
        expect(dialog.locator(".activity-count")).to_have_text("100 unread")
        dialog.get_by_role("button", name="Mark visible as read", exact=True).click()
        expect(dialog.locator(".activity-count")).to_have_text("0 unread")
        ids = self.rpc_body("mark_activity_read")["activity_ids"]
        self.assertEqual(len(ids), 100)
        self.assertEqual(len(set(ids)), 100)
        self.assertNotIn(items[0]["id"], ids)
        self.assertIsNone(items[0]["read_at"])

    def test_12_unverifiable_review_never_claims_only_me_or_exposes_stale_names(self):
        feed = self.sign_in_feed()
        feed.locator(".social-recipient-picker").get_by_role("button", name="All current friends", exact=True).click()
        review = feed.get_by_role("region", name="Audience review", exact=True)
        review.locator("summary").click()
        expect(review.get_by_text("Test Bea", exact=True)).to_be_visible()
        self.service.connection_error = True
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        expect(review.get_by_role("alert")).to_contain_text("review the selection")
        expect(review.get_by_text("Sharing with 1 friend", exact=True)).to_be_visible()
        expect(review.get_by_text("Recipient unavailable", exact=True)).to_be_visible()
        expect(review.get_by_text("Test Bea", exact=True)).to_have_count(0)
        expect(review.get_by_text("Only me", exact=True)).to_have_count(0)
        feed.get_by_role("textbox", name="Your update", exact=True).fill("Do not publish an unverifiable audience")
        expect(feed.get_by_role("button", name="Publish update", exact=True)).to_be_disabled()
        self.assertEqual(self.service.matching("/rest/v1/rpc/create_social_post", "POST"), [])

    def test_13_deleted_target_is_evicted_from_cached_feed_even_after_closing(self):
        self.service.add_activity("post_like", post_id=social.POST_ID)
        feed = self.sign_in_feed()
        expect(feed.get_by_text("A real invitation-only update from Bea.", exact=True)).to_be_visible()
        dialog = self.inbox()
        # The item was visible when the inbox loaded, but its source has since
        # disappeared. The old base feed must not restore it after target close.
        self.service.current_social()["posts"] = []
        dialog.get_by_role("button", name="Unread: Test Bea liked your update", exact=True).click()
        expect(self.page.get_by_text(re.compile(r"no longer available", re.I))).to_be_visible()
        expect(feed.get_by_text("A real invitation-only update from Bea.", exact=True)).to_have_count(0)
        self.page.get_by_role("button", name="Close opened item", exact=True).click()
        expect(self.page.get_by_role("button", name="Close opened item", exact=True)).to_have_count(0)
        expect(feed.get_by_text("A real invitation-only update from Bea.", exact=True)).to_have_count(0)
        expect(self.page.get_by_text("Home safely!", exact=True)).to_have_count(0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
