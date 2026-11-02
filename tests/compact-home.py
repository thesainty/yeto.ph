"""Compact Home interaction contracts against intercepted, fictional accounts.

Run with the local servers described in accounts.py. No hosted writes occur.
"""
import re
from pathlib import Path
import unittest

from playwright.sync_api import expect
import accounts
import circles
import social


class CompactHomeTests(unittest.TestCase):
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
    rpc_body = social.SocialBrowserTests.rpc_body
    add_friend = circles.CircleBrowserTests.add_friend
    seed_circle = circles.CircleBrowserTests.seed_circle
    refresh_relationships = circles.CircleBrowserTests.refresh_relationships

    def settle(self):
        self.page.evaluate("""async () => {
            await Promise.all(document.getAnimations().filter(animation =>
                animation.effect?.getComputedTiming().iterations !== Infinity
            ).map(animation => animation.finished.catch(() => {})));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }""")

    def screenshot(self, name):
        Path("test-results").mkdir(exist_ok=True)
        self.settle()
        self.page.screenshot(path=f"test-results/compact-home-{name}.png", full_page=True)

    def navigate(self, name):
        nav = "Mobile navigation" if self.page.viewport_size["width"] < 800 else "Main navigation"
        self.page.get_by_role("navigation", name=nav, exact=True).get_by_role("button", name=re.compile(rf"^{name}(?:$|\s)")).click()

    def test_01_default_home_is_compact_in_both_themes_and_mobile_sizes(self):
        feed = self.sign_in_feed()
        self.page.emulate_media(reduced_motion="reduce")
        for dark in (False, True):
            toggle = self.page.get_by_role("switch", name="Dark mode", exact=True)
            if (toggle.get_attribute("aria-checked") == "true") != dark:
                toggle.click()
            for width in (1440, 375, 320):
                with self.subTest(dark=dark, width=width):
                    self.page.set_viewport_size({"width": width, "height": 812})
                    self.page.evaluate("window.scrollTo(0, 0)")
                    expect(feed.get_by_role("button", name="Share an update", exact=True)).to_be_visible()
                    expect(feed.get_by_role("textbox", name="Your update", exact=True)).to_have_count(0)
                    expect(self.page.get_by_role("searchbox", name="Search friends", exact=True)).to_have_count(0)
                    expect(self.page.get_by_label("Find someone by username", exact=True)).to_have_count(0)
                    expect(self.page.locator(".social-recipient-picker")).to_have_count(0)
                    expect(self.page.get_by_role("button", name="Create circle", exact=True)).to_have_count(0)
                    expect(self.page.locator(".right-rail")).to_have_count(0)
                    card = feed.locator("article").first
                    expect(card).to_be_visible()
                    box = card.bounding_box()
                    self.assertLessEqual(box["y"] + min(box["height"], 130), 640, "A meaningful part of the first update should be visible without scrolling")
                    self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth"), width)
                    self.screenshot(f"{'dark' if dark else 'light'}-{width}")

    def test_02_compose_review_and_publish_send_only_explicit_recipients(self):
        self.seed_circle()
        self.sign_in_feed()
        dialog = accounts.open_post(self.page)
        expect(dialog.get_by_role("button", name="Audience: Only me", exact=True)).to_be_visible()
        expect(dialog.get_by_role("region", name="Audience review", exact=True)).to_contain_text("This update is visible only to you.")
        expect(dialog.get_by_role("searchbox")).to_have_count(0)
        dialog.get_by_role("textbox", name="Your update", exact=True).fill("A compact private update")
        dialog.get_by_role("button", name="Publish update", exact=True).click()
        expect(self.page.get_by_role("dialog")).to_have_count(0)
        self.assertEqual(self.rpc_body("create_social_post"), {"body_text": "A compact private update", "viewer_ids": []})
        dialog = accounts.open_post(self.page)
        expect(dialog.get_by_role("textbox", name="Your update", exact=True)).to_have_value("")
        expect(dialog.get_by_role("button", name="Audience: Only me", exact=True)).to_be_visible()
        dialog.get_by_role("textbox", name="Your update", exact=True).fill("A chosen family audience")
        audience = accounts.open_audience(self.page)
        audience.get_by_role("button", name="Use Pamilya", exact=True).click()
        expect(audience.get_by_role("textbox", name="Your update", exact=True)).to_have_count(0)
        dialog = accounts.open_post(self.page)
        dialog.get_by_text("Review 1 recipient", exact=True).click()
        recipients = dialog.get_by_role("list", name="Selected recipients", exact=True)
        expect(recipients).to_contain_text("Test Bea")
        expect(recipients).to_contain_text("@bea_real_test")
        self.screenshot("desktop-audience-review")
        dialog.get_by_role("button", name="Publish update", exact=True).click()
        expect(self.page.get_by_role("dialog")).to_have_count(0)
        self.assertEqual(self.rpc_body("create_social_post"), {"body_text": "A chosen family audience", "viewer_ids": [accounts.FRIEND_ID]})
        expect(self.page.get_by_role("button", name="Share an update", exact=True)).to_be_visible()

    def test_03_keyboard_cancel_keeps_draft_and_account_switch_clears_it(self):
        self.sign_in_feed()
        prompt = self.page.get_by_role("button", name="Share an update", exact=True)
        prompt.focus()
        self.page.keyboard.press("Enter")
        dialog = self.page.get_by_role("dialog", name="Create update", exact=True)
        expect(dialog).to_be_visible()
        dialog.get_by_role("textbox", name="Your update", exact=True).fill("Maria unsent private draft")
        audience = accounts.open_audience(self.page)
        audience.get_by_role("button", name="All current friends", exact=True).click()
        self.page.keyboard.press("Escape")
        expect(dialog).to_be_visible()
        expect(dialog.get_by_role("button", name="Audience: 1 friend", exact=True)).to_be_focused()
        self.page.keyboard.press("Escape")
        expect(self.page.get_by_role("dialog")).to_have_count(0)
        expect(self.page.get_by_role("button", name="Continue update", exact=True)).to_be_focused()
        dialog = accounts.open_post(self.page)
        expect(dialog.get_by_role("textbox", name="Your update", exact=True)).to_have_value("Maria unsent private draft")
        expect(dialog.get_by_role("button", name="Audience: 1 friend", exact=True)).to_be_visible()
        self.open_account().get_by_role("button", name="Sign out", exact=True).click()
        self.service.switch_user(accounts.SECOND_USER_ID, "Luna Other", "luna_other", "luna@example.test")
        self.submit_sign_in(self.account())
        self.close_account()
        dialog = accounts.open_post(self.page)
        expect(dialog.get_by_role("textbox", name="Your update", exact=True)).to_have_value("")
        expect(dialog.get_by_role("button", name="Audience: Only me", exact=True)).to_be_visible()
        self.assertEqual(self.service.matching("/rest/v1/rpc/create_social_post", "POST"), [])

    def test_04_picker_closed_drafts_never_expand_and_removed_friends_are_pruned(self):
        circle = self.seed_circle()
        self.sign_in_feed()
        audience = accounts.open_audience(self.page)
        audience.get_by_role("button", name="Use Pamilya", exact=True).click()
        dialog = accounts.open_post(self.page)
        dialog.get_by_role("textbox", name="Your update", exact=True).fill("The original Pamilya snapshot")
        self.add_friend()
        circle["member_ids"].append(accounts.INCOMING_ID)
        self.refresh_relationships()
        expect(dialog.get_by_role("button", name="Audience: 1 friend", exact=True)).to_be_visible()
        dialog.get_by_role("button", name="Publish update", exact=True).click()
        expect(dialog).to_have_count(0)
        self.assertEqual(self.rpc_body("create_social_post")["viewer_ids"], [accounts.FRIEND_ID])
        audience = accounts.open_audience(self.page)
        audience.get_by_role("button", name="All current friends", exact=True).click()
        dialog = accounts.open_post(self.page)
        expect(dialog.get_by_role("button", name="Audience: 2 friends", exact=True)).to_be_visible()
        dialog.get_by_role("textbox", name="Your update", exact=True).fill("A removed friend cannot receive this")
        self.service.friendships = [row for row in self.service.friendships if accounts.FRIEND_ID not in (row["user_a"], row["user_b"])]
        self.refresh_relationships()
        expect(dialog.get_by_role("button", name="Audience: 1 friend", exact=True)).to_be_visible()
        dialog.get_by_text("Review 1 recipient", exact=True).click()
        expect(dialog.get_by_role("list", name="Selected recipients", exact=True)).to_contain_text("Test Ana")
        expect(dialog.get_by_role("list", name="Selected recipients", exact=True)).not_to_contain_text("Test Bea")
        dialog.get_by_role("button", name="Publish update", exact=True).click()
        expect(dialog).to_have_count(0)
        self.assertEqual(self.rpc_body("create_social_post")["viewer_ids"], [accounts.INCOMING_ID])

    def test_05_friend_discovery_stays_in_friends_and_mobile_composer_fits(self):
        self.sign_in_feed()
        self.page.emulate_media(reduced_motion="reduce")
        self.page.set_viewport_size({"width": 375, "height": 812})
        self.navigate("Friends")
        panel = self.page.get_by_role("main").locator(".connections-panel")
        panel.get_by_label("Find someone by username", exact=True).fill("nico_real_test")
        panel.get_by_role("button", name="Find", exact=True).click()
        expect(panel.get_by_role("button", name="Send friend request to Test Nico", exact=True)).to_be_visible()
        self.navigate("Home")
        expect(self.page.get_by_label("Find someone by username", exact=True)).to_have_count(0)
        for dark in (False, True):
            toggle = self.page.get_by_role("switch", name="Dark mode", exact=True)
            if (toggle.get_attribute("aria-checked") == "true") != dark:
                toggle.click()
            for width in (375, 320):
                self.page.set_viewport_size({"width": width, "height": 812})
                dialog = accounts.open_post(self.page)
                dialog.get_by_role("textbox", name="Your update", exact=True).fill("A mobile unsent update")
                self.screenshot(f"compose-{'dark' if dark else 'light'}-{width}")
                audience = accounts.open_audience(self.page)
                expect(audience.get_by_role("searchbox", name="Search friends", exact=True)).to_be_visible()
                self.assertLessEqual(audience.bounding_box()["width"], width)
                self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth"), width)
                audience.get_by_role("button", name="Done choosing audience", exact=True).focus()
                self.page.keyboard.press("Tab")
                expect(audience.get_by_role("button", name="Close dialog", exact=True)).to_be_focused()
                self.page.keyboard.press("Shift+Tab")
                expect(audience.get_by_role("button", name="Done choosing audience", exact=True)).to_be_focused()
                self.screenshot(f"choose-audience-{'dark' if dark else 'light'}-{width}")
                audience.get_by_role("button", name="Close dialog", exact=True).click()
                expect(self.page.get_by_role("dialog")).to_have_count(0)
                expect(self.page.get_by_role("button", name="Continue update", exact=True)).to_be_visible()


if __name__ == "__main__":
    unittest.main(verbosity=2)
