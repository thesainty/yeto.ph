"""Saved-audience browser contracts using intercepted fake account HTTP only.

Start the two local servers documented in accounts.py, then run:
  python tests/circles.py
Database authorization and audience revocation are tested separately in
circles-database.test.mjs. These checks never contact a hosted Supabase project.
"""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import unittest

from playwright.sync_api import expect
import accounts
import social


class CircleBrowserTests(unittest.TestCase):
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

    def picker(self, within=None):
        return (within or self.page).locator(".social-recipient-picker")

    def add_friend(self, friend_id=accounts.INCOMING_ID):
        if friend_id not in self.service.other_profiles:
            number = len(self.service.other_profiles)
            self.service.other_profiles[friend_id] = {
                "id": friend_id, "username": f"friend_{number:04d}", "display_name": f"Friend {number:04d}",
            }
        self.service.friendships.append({
            "id": f"friendship-{friend_id}", "user_a": self.service.user_id,
            "user_b": friend_id, "created_at": accounts.NOW,
        })

    def add_friends_until(self, total):
        while len(self.service.friendships) < total:
            number = len(self.service.friendships)
            self.add_friend(f"{number:08x}-a000-4000-8000-000000000000")

    def seed_circle(self, name="Pamilya", members=None, owner=accounts.USER_ID):
        circle = {"id": "aaaaaaaa-aaaa-4aaa-8aaa-000000000099", "name": name,
                  "member_ids": list(members if members is not None else [accounts.FRIEND_ID])}
        self.service.circles_by_user.setdefault(owner, []).append(circle)
        return circle

    def refresh_relationships(self):
        with self.page.expect_request(f"**{accounts.MOCK_HOST}/rest/v1/friendships?*"):
            self.page.evaluate("window.dispatchEvent(new Event('focus'))")

    def publish(self, text):
        feed = self.page.get_by_role("region", name="Real feed", exact=True)
        feed.get_by_role("textbox", name="Your update", exact=True).fill(text)
        feed.get_by_role("button", name="Publish update", exact=True).click()
        expect(feed.get_by_text(text, exact=True)).to_be_visible()
        return self.rpc_body("create_social_post")

    def editor(self):
        return self.page.get_by_role("group", name=re.compile(r"^(Create|Edit) circle$"))

    def test_01_private_default_all_friends_search_and_fixed_draft(self):
        self.add_friends_until(61)
        feed = self.sign_in_feed()
        picker = self.picker(feed)
        expect(picker.get_by_text(re.compile(r"^Only me\."))).to_be_visible()
        expect(picker.locator("input[type=checkbox]:checked")).to_have_count(0)
        self.assertEqual(self.publish("A private default"), {"body_text": "A private default", "viewer_ids": []})
        picker.get_by_role("button", name="All current friends", exact=True).click()
        expect(picker.locator("input[type=checkbox]:checked")).to_have_count(61)
        selected_ids = [row["user_b"] for row in self.service.friendships]
        picker.get_by_role("searchbox", name="Search friends", exact=True).fill("@BEA_REAL")
        picker.get_by_role("searchbox", name="Search friends", exact=True).press("Enter")
        self.assertEqual(len(self.service.matching("/rest/v1/rpc/create_social_post", "POST")), 1, "Searching must not submit the parent post form")
        expect(picker.get_by_role("checkbox")).to_have_count(1)
        expect(picker.get_by_role("checkbox", name="Test Bea (@bea_real_test)", exact=True)).to_be_checked()
        expect(picker.get_by_text(re.compile(r"^61 selected friends"))).to_be_visible()
        picker.get_by_role("searchbox", name="Search friends", exact=True).fill("")
        self.add_friend()
        self.refresh_relationships()
        expect(picker.get_by_role("checkbox", name="Test Ana (@ana_real_test)", exact=True)).not_to_be_checked()
        expect(picker.locator("input[type=checkbox]:checked")).to_have_count(61)
        body = self.publish("All friends from that tap")
        self.assertCountEqual(body["viewer_ids"], selected_ids)
        self.assertNotIn(accounts.INCOMING_ID, body["viewer_ids"])
        picker.get_by_role("button", name="All current friends", exact=True).click()
        expect(picker.locator("input[type=checkbox]:checked")).to_have_count(62)
        picker.get_by_role("button", name="Only me", exact=True).click()
        self.assertEqual(self.publish("Private again")["viewer_ids"], [])

    def test_02_circle_create_rename_members_reload_delete_do_not_expand_old_audiences(self):
        self.add_friend()
        feed = self.sign_in_feed()
        picker = self.picker(feed)
        picker.get_by_role("button", name="Create circle", exact=True).click()
        editor = self.editor()
        editor.get_by_role("button", name="Pamilya", exact=True).click()
        editor.get_by_role("checkbox", name="Test Bea (@bea_real_test)", exact=True).check()
        editor.get_by_role("button", name="Save circle", exact=True).click()
        expect(editor).to_have_count(0)
        expect(picker.get_by_role("button", name="Use Pamilya", exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("save_audience_circle"), {
            "circle_id": None, "circle_name": "Pamilya", "member_ids": [accounts.FRIEND_ID],
        })
        expect(picker.locator("input[type=checkbox]:checked")).to_have_count(0)
        picker.get_by_role("button", name="Use Pamilya", exact=True).click()
        first_body = self.publish("A fixed Pamilya audience")
        self.assertEqual(first_body["viewer_ids"], [accounts.FRIEND_ID])
        picker.get_by_role("button", name="Use Pamilya", exact=True).click()
        picker.get_by_role("button", name="Edit Pamilya", exact=True).click()
        editor = self.editor()
        editor.get_by_role("textbox", name="Circle name", exact=True).fill("Barkada")
        editor.get_by_role("searchbox", name="Search circle members", exact=True).fill("ana")
        editor.get_by_role("checkbox", name="Test Ana (@ana_real_test)", exact=True).check()
        editor.get_by_role("button", name="Save circle", exact=True).click()
        expect(picker.get_by_role("button", name="Use Barkada", exact=True)).to_be_visible()
        expect(picker.locator("input[type=checkbox]:checked")).to_have_count(1)
        Path("test-results").mkdir(exist_ok=True)
        self.page.screenshot(path="test-results/circles-desktop.png", full_page=True)
        self.assertEqual(self.rpc_body("create_social_post"), first_body, "Editing circles must not republish old posts")
        self.assertEqual(self.service.current_social()["posts"][0]["audience_count"], 1)
        picker.get_by_role("button", name="Use Barkada", exact=True).click()
        expect(picker.locator("input[type=checkbox]:checked")).to_have_count(2)
        picker.get_by_role("button", name="Delete Barkada", exact=True).click()
        picker.get_by_role("button", name="Keep circle", exact=True).click()
        expect(picker.get_by_role("button", name="Use Barkada", exact=True)).to_be_visible()
        self.page.reload()
        picker = self.picker()
        expect(picker.get_by_role("button", name="Use Barkada", exact=True)).to_be_visible()
        expect(picker.locator("input[type=checkbox]:checked")).to_have_count(0)
        picker.get_by_role("button", name="Use Barkada", exact=True).click()
        picker.get_by_role("button", name="Delete Barkada", exact=True).click()
        picker.get_by_role("button", name="Delete circle", exact=True).click()
        expect(picker.get_by_role("button", name="Use Barkada", exact=True)).to_have_count(0)
        expect(picker.locator("input[type=checkbox]:checked")).to_have_count(2)
        body = self.publish("Recipients survive deleting the shortcut")
        self.assertCountEqual(body["viewer_ids"], [accounts.FRIEND_ID, accounts.INCOMING_ID])
        self.assertEqual(self.service.current_circles(), [])
        self.assertFalse(self.page.evaluate("Object.values(localStorage).some(value => value.includes('Barkada') || value.includes('Pamilya'))"), "Private saved circles must not enter browser/demo storage")

    def test_03_same_saved_circle_picker_snapshots_plan_invitations(self):
        circle = self.seed_circle("Close friends")
        self.sign_in_feed()
        main = self.main_plans()
        main.get_by_role("button", name="Make a plan", exact=True).click()
        form = main.get_by_role("form", name="Create a real plan", exact=True)
        picker = self.picker(form)
        expect(picker.locator("input[type=checkbox]:checked")).to_have_count(0)
        form.get_by_label("Plan title", exact=True).fill("Circle coffee")
        form.get_by_label("Meeting place", exact=True).fill("Our chosen café")
        future = datetime.now(timezone.utc) + timedelta(days=5)
        form.get_by_label("Date", exact=True).fill(future.strftime("%Y-%m-%d"))
        form.get_by_label("Time (Philippines)", exact=True).fill("16:00")
        picker.get_by_role("button", name="Use Close friends", exact=True).click()
        # A server-side circle edit after the tap must not expand this plan draft.
        self.add_friend()
        circle["member_ids"].append(accounts.INCOMING_ID)
        self.refresh_relationships()
        expect(picker.get_by_role("checkbox", name="Test Ana (@ana_real_test)", exact=True)).not_to_be_checked()
        form.get_by_role("button", name="Save plan", exact=True).click()
        expect(main.get_by_role("heading", name="Circle coffee", exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("create_social_plan")["invitee_ids"], [accounts.FRIEND_ID])
        self.assertEqual(self.page.locator("form form").count(), 0)
        self.assertEqual(self.service.matching("/rest/v1/rpc/create_social_post", "POST"), [])

    def test_04_late_old_account_circles_never_leak_or_restore_drafts(self):
        self.seed_circle("Private family shortcut")
        feed = self.sign_in_feed()
        picker = self.picker(feed)
        expect(picker.get_by_role("button", name="Use Private family shortcut", exact=True)).to_be_visible()
        picker.get_by_role("button", name="Create circle", exact=True).click()
        self.editor().get_by_role("textbox", name="Circle name", exact=True).fill("Unsent first account circle")
        self.service.hold_circles_snapshot = True
        with self.page.expect_request(f"**{accounts.MOCK_HOST}/rest/v1/rpc/audience_circles_snapshot"):
            self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        self.open_account().get_by_role("button", name="Sign out", exact=True).click()
        expect(self.account().get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        self.service.switch_user(accounts.SECOND_USER_ID, "Luna Other", "luna_other", "luna@example.test")
        self.submit_sign_in(self.account())
        self.close_account()
        picker = self.picker()
        expect(picker.get_by_role("button", name="Create circle", exact=True)).to_be_enabled()
        self.assertEqual(len(self.service.held_circles_snapshots), 1)
        route, old = self.service.held_circles_snapshots[0]
        route.fulfill(status=200, headers=social.HEADERS, body=json.dumps(old))
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        expect(picker.get_by_role("button", name="Use Private family shortcut", exact=True)).to_have_count(0)
        expect(self.editor()).to_have_count(0)
        expect(picker.locator("input[type=checkbox]:checked")).to_have_count(0)
        picker.get_by_role("button", name="Create circle", exact=True).click()
        expect(self.editor().get_by_role("textbox", name="Circle name", exact=True)).to_have_value("")
        self.assertEqual(self.service.matching("/rest/v1/rpc/save_audience_circle", "POST"), [])

    def test_05_missing_upgrade_and_failed_circle_save_keep_manual_audiences_usable(self):
        self.service.circles_error = "PGRST202"
        feed = self.sign_in_feed()
        picker = self.picker(feed)
        expect(picker).to_contain_text("Saved circles aren’t available yet")
        picker.get_by_role("button", name="All current friends", exact=True).click()
        self.assertEqual(self.publish("Manual sharing without saved circles")["viewer_ids"], [accounts.FRIEND_ID])
        self.service.circles_error = None
        self.page.reload()
        picker = self.picker()
        picker.get_by_role("button", name="Create circle", exact=True).click()
        editor = self.editor()
        editor.get_by_role("textbox", name="Circle name", exact=True).fill("Keep my unsaved circle")
        editor.get_by_role("checkbox", name="Test Bea (@bea_real_test)", exact=True).check()
        self.service.circle_mutation_error = True
        editor.get_by_role("button", name="Save circle", exact=True).click()
        expect(editor.get_by_role("alert")).to_be_visible()
        expect(editor.get_by_role("textbox", name="Circle name", exact=True)).to_have_value("Keep my unsaved circle")
        self.assertEqual(self.service.current_circles(), [])
        self.service.circle_mutation_error = False
        editor.get_by_role("button", name="Save circle", exact=True).click()
        expect(picker.get_by_role("button", name="Use Keep my unsaved circle", exact=True)).to_be_visible()
        expect(picker.locator("input[type=checkbox]:checked")).to_have_count(0)

    def test_06_500_recipients_allowed_and_501_never_silently_truncated(self):
        self.add_friends_until(500)
        feed = self.sign_in_feed()
        picker = self.picker(feed)
        expect(picker.get_by_role("checkbox")).to_have_count(500)
        picker.get_by_role("button", name="All current friends", exact=True).click()
        expect(picker.locator("input[type=checkbox]:checked")).to_have_count(500)
        self.add_friend()
        self.refresh_relationships()
        expect(picker.get_by_role("checkbox")).to_have_count(501)
        expect(picker.get_by_role("button", name="All current friends", exact=True)).to_be_disabled()
        expect(picker.locator("input[type=checkbox]:checked")).to_have_count(500)
        expect(picker.get_by_role("checkbox", name="Test Ana (@ana_real_test)", exact=True)).to_be_disabled()
        body = self.publish("A deliberate 500-person snapshot")
        self.assertEqual(len(body["viewer_ids"]), 500)
        self.assertNotIn(accounts.INCOMING_ID, body["viewer_ids"])
        expect(picker.get_by_role("button", name="All current friends", exact=True)).to_be_disabled()

    def test_07_full_friend_pagination_searches_beyond_1000_without_partial_all(self):
        self.add_friends_until(1001)
        feed = self.sign_in_feed()
        picker = self.picker(feed)
        expect(picker.get_by_role("checkbox")).to_have_count(1001)
        expect(picker.get_by_role("button", name="All current friends", exact=True)).to_be_disabled()
        picker.get_by_role("searchbox", name="Search friends", exact=True).fill("friend_1002")
        expect(picker.get_by_role("checkbox")).to_have_count(1)
        picker.get_by_role("checkbox").check()
        self.assertEqual(len(self.publish("One friend from beyond page two")["viewer_ids"]), 1)
        friendship_reads = self.service.matching("/rest/v1/friendships", "GET")
        self.assertTrue(any(call["query"].get("offset") == ["1000"] for call in friendship_reads))

    def test_08_mobile_circle_editor_keyboard_does_not_publish_parent_form(self):
        self.seed_circle()
        self.sign_in_feed()
        for width in [375, 320]:
            with self.subTest(width=width):
                self.page.set_viewport_size({"width": width, "height": 812})
                picker = self.picker()
                self.page.get_by_role("textbox", name="Your update", exact=True).fill("Do not publish while editing a circle")
                picker.get_by_role("button", name="Create circle", exact=True).click()
                editor = self.editor()
                name = editor.get_by_role("textbox", name="Circle name", exact=True)
                name.fill(f"Mobile circle {width}")
                name.press("Enter")
                expect(self.page.get_by_role("textbox", name="Your update", exact=True)).to_have_value("Do not publish while editing a circle")
                self.assertEqual(self.service.matching("/rest/v1/rpc/create_social_post", "POST"), [])
                expect(editor).to_be_visible()
                dimensions = self.page.evaluate("({width:innerWidth, scroll:document.documentElement.scrollWidth})")
                self.assertLessEqual(dimensions["scroll"], dimensions["width"])
                Path("test-results").mkdir(exist_ok=True)
                self.page.screenshot(path=f"test-results/circles-mobile-editor-{width}.png", full_page=True)
                editor.get_by_role("checkbox", name="Test Bea (@bea_real_test)", exact=True).check()
                editor.get_by_role("button", name="Save circle", exact=True).press("Enter")
                expect(picker.get_by_role("button", name=f"Use Mobile circle {width}", exact=True)).to_be_visible()
                expect(picker.locator("input[type=checkbox]:checked")).to_have_count(0)
                Path("test-results").mkdir(exist_ok=True)
                self.page.screenshot(path=f"test-results/circles-mobile-{width}.png", full_page=True)

    def test_09_existing_lower_row_cap_does_not_hide_current_friends_or_profiles(self):
        self.add_friends_until(201)
        self.service.row_limit = 37
        feed = self.sign_in_feed()
        picker = self.picker(feed)
        expect(picker.get_by_role("checkbox")).to_have_count(201)
        picker.get_by_role("button", name="All current friends", exact=True).click()
        expect(picker.locator("input[type=checkbox]:checked")).to_have_count(201)
        picker.get_by_role("searchbox", name="Search friends", exact=True).fill("friend_0202")
        expect(picker.get_by_role("checkbox")).to_have_count(1)
        expect(picker.get_by_role("checkbox")).to_be_checked()
        body = self.publish("All friends despite an existing 37-row API cap")
        self.assertEqual(len(body["viewer_ids"]), 201)
        self.assertEqual(len(set(body["viewer_ids"])), 201)
        friendship_reads = self.service.matching("/rest/v1/friendships", "GET")
        self.assertTrue(any(call["query"].get("offset") == ["185"] for call in friendship_reads))
        profile_reads = [call for call in self.service.matching("/rest/v1/profiles", "GET") if call["query"].get("id", [""])[0].startswith("in.(")]
        self.assertTrue(any(call["query"].get("offset") == ["37"] for call in profile_reads), "Profile chunks must also respect existing lower row caps")


if __name__ == "__main__":
    unittest.main(verbosity=2)
