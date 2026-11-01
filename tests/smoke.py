"""Browser smoke tests for Yeto's local demo workflows.

Run the Vite server, then: python tests/smoke.py
Requires Python Playwright and Chromium (YETO_CHROMIUM overrides its path).
YETO_TEST_URL defaults to http://127.0.0.1:5173.
Every test uses a fresh browser context and only fictional demo data.
"""
from datetime import date, timedelta
import json
import os
from pathlib import Path
import re
import unittest

from playwright.sync_api import sync_playwright, expect

BASE_URL = os.environ.get("YETO_TEST_URL", "http://127.0.0.1:5173")
STORAGE_KEY = "yeto-demo-v1"


class YetoSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            executable_path=os.environ.get("YETO_CHROMIUM", "/usr/bin/chromium"),
            headless=True,
            args=["--no-sandbox"],
        )

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 1000})
        self.page = self.context.new_page()
        self.page.set_default_timeout(7000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(BASE_URL)
        expect(self.page.get_by_role("heading", name="Tara, Mika!")).to_be_visible()
        self.page.wait_for_function("localStorage.getItem('yeto-demo-v1') !== null")

    def tearDown(self):
        if self.errors:
            Path("test-results").mkdir(exist_ok=True)
            self.page.screenshot(path=f"test-results/{self._testMethodName}.png", full_page=True)
        self.context.close()
        self.assertEqual(self.errors, [], "Uncaught browser errors")

    def state(self):
        return self.page.evaluate("key => JSON.parse(localStorage.getItem(key))", STORAGE_KEY)

    def wait_for_state(self, expression):
        self.page.wait_for_function(
            f"() => {{ const s = JSON.parse(localStorage.getItem('{STORAGE_KEY}')); return {expression}; }}"
        )

    def main(self):
        return self.page.get_by_role("main")

    def navigate(self, name):
        nav_name = "Mobile navigation" if self.page.viewport_size["width"] < 800 else "Main navigation"
        self.page.get_by_role("navigation", name=nav_name, exact=True).get_by_role(
            "button", name=re.compile(rf"^{name}(?:$|\s)")
        ).click()

    def open_share(self):
        self.navigate("Home")
        self.main().get_by_role("button", name="Share a journey", exact=True).click()
        return self.page.get_by_role("dialog")

    def test_01_plan_join_leave_and_reload(self):
        """Attendance remains consistent between the feed, Plans, and persisted state."""
        card = self.main().locator("article").filter(has=self.page.get_by_role("heading", name="Coffee in BGC?", exact=True))
        expect(card.get_by_text("3 going", exact=True)).to_be_visible()
        card.get_by_role("button", name="Join plan").click()
        expect(card.get_by_text("4 going, including you", exact=True)).to_be_visible()
        self.wait_for_state("s.plans[0].joined && s.plans[0].attendees.filter(p => p === 'mika').length === 1")
        self.navigate("Plans")
        plan = self.main().locator("article").filter(has=self.page.get_by_role("heading", name="Coffee in BGC?", exact=True))
        expect(plan.get_by_text("4 going", exact=True)).to_be_visible()
        self.page.reload()
        expect(self.main().get_by_role("button", name="Leave Coffee in BGC?", exact=True)).to_be_visible()
        self.main().get_by_role("button", name="Leave Coffee in BGC?", exact=True).click()
        expect(plan.get_by_text("3 going", exact=True)).to_be_visible()
        self.wait_for_state("!s.plans[0].joined && !s.plans[0].attendees.includes('mika')")
        self.navigate("Home")
        expect(card.get_by_text("3 going", exact=True)).to_be_visible()
        self.page.reload()
        self.assertFalse(self.state()["plans"][0]["joined"])

    def test_02_friend_requests_removal_and_separate_sharing(self):
        """Friend acceptance never enables sharing; removals and outgoing requests persist."""
        self.navigate("Friends")
        self.main().get_by_role("button", name="Accept request", exact=True).click()
        self.wait_for_state("s.friendIds.includes('ana') && s.requestStatus === 'accepted' && s.sharing === null")
        dialog = self.open_share()
        dialog.get_by_role("button", name="Start demo journey", exact=True).click()
        self.wait_for_state("s.sharing !== null")
        self.navigate("Friends")
        self.main().get_by_role("button", name="Options for Bea", exact=True).click()
        self.main().get_by_role("button", name="Remove friend", exact=True).click()
        self.wait_for_state("!s.friendIds.includes('bea') && s.sharing === null")
        self.page.reload()
        expect(self.main().get_by_role("button", name="Options for Ana", exact=True)).to_be_visible()
        expect(self.main().get_by_role("button", name="Options for Bea", exact=True)).to_have_count(0)
        mini_map = self.page.get_by_role("button", name="Open the demo circle map", exact=True)
        expect(mini_map.get_by_role("img", name="Bea", exact=True)).to_have_count(0)
        self.main().get_by_role("searchbox", name="Search friends", exact=True).fill("Luis")
        expect(self.main().get_by_role("button", name="Options for Luis", exact=True)).to_be_visible()
        expect(self.main().get_by_role("button", name="Options for Ana", exact=True)).to_have_count(0)
        self.main().get_by_role("searchbox", name="Search friends", exact=True).fill("")
        self.main().get_by_role("button", name="Add friends", exact=True).click()
        dialog = self.page.get_by_role("dialog")
        dialog.get_by_role("textbox", name="Name or username", exact=True).fill("Nico")
        dialog.get_by_role("button", name="Add friend", exact=True).click()
        expect(dialog.get_by_role("button", name="Request sent", exact=True)).to_be_disabled()
        self.wait_for_state("s.outgoingRequests.includes('nico') && s.sharing === null")
        self.page.keyboard.press("Escape")
        self.page.reload()
        self.assertIn("nico", self.state()["outgoingRequests"])
        self.navigate("Map")
        expect(self.main().get_by_role("button", name="Show Bea's sample location", exact=True)).to_have_count(0)

    def test_03_new_plan_validation_and_persistence(self):
        """Required values, whitespace, past dates, and missing times cannot create plans."""
        self.navigate("Plans")
        self.main().get_by_role("button", name="Make a plan", exact=True).click()
        dialog = self.page.get_by_role("dialog")
        submit = dialog.get_by_role("button", name="Make it a plan", exact=True)
        submit.click()
        expect(dialog).to_be_visible()
        self.assertEqual(len(self.state()["plans"]), 3)
        title = dialog.get_by_role("textbox", name="What’s the plan?", exact=True)
        place = dialog.get_by_role("textbox", name="Where are we meeting?", exact=True)
        day = dialog.get_by_label("Date", exact=True)
        time = dialog.get_by_label("Time (Philippines)", exact=True)
        min_date = date.fromisoformat(day.get_attribute("min"))
        title.fill("   ")
        place.fill("Ayala Triangle")
        day.fill((min_date + timedelta(days=1)).isoformat())
        time.fill("17:45")
        submit.click()
        expect(dialog).to_be_visible()
        title.fill("Sunset kwentuhan")
        place.fill("   ")
        submit.click()
        expect(dialog).to_be_visible()
        place.fill("Ayala Triangle")
        day.fill((min_date - timedelta(days=1)).isoformat())
        submit.click()
        expect(dialog).to_be_visible()
        self.assertTrue(day.evaluate("element => element.validity.rangeUnderflow"))
        day.fill((min_date + timedelta(days=1)).isoformat())
        time.fill("")
        submit.click()
        expect(dialog).to_be_visible()
        time.fill("17:45")
        dialog.get_by_role("button", name="Good food", exact=True).click()
        submit.click()
        expect(dialog).to_have_count(0)
        expect(self.main().get_by_role("heading", name="Sunset kwentuhan", exact=True)).to_be_visible()
        self.wait_for_state("s.plans.length === 4 && s.plans[0].title === 'Sunset kwentuhan'")
        created = self.state()["plans"][0]
        self.assertEqual(created["place"], "Ayala Triangle")
        self.assertEqual(created["kind"], "food")
        self.assertEqual(created["attendees"], ["mika"])
        self.assertTrue(created["joined"])
        self.assertIn("5:45", created["time"])
        self.page.reload()
        expect(self.main().get_by_role("heading", name="Sunset kwentuhan", exact=True)).to_be_visible()
        self.main().get_by_role("button", name=re.compile("^My plans")).click()
        expect(self.main().get_by_role("heading", name="Sunset kwentuhan", exact=True)).to_be_visible()
        expect(self.main().get_by_role("heading", name="Coffee in BGC?", exact=True)).to_have_count(0)

    def test_04_comments_likes_and_checkins_persist(self):
        """Social actions persist and text content renders without HTML interpretation."""
        self.main().get_by_role("button", name="Like Paolo’s check-in", exact=True).click()
        expect(self.main().get_by_role("button", name="Unlike Paolo’s check-in", exact=True)).to_have_attribute("aria-pressed", "true")
        self.main().get_by_role("button", name="Say something nice", exact=True).click()
        expect(self.main().get_by_role("button", name="Send comment", exact=True)).to_be_disabled()
        message = "Ingat, Paolo! <b>See you tomorrow</b>"
        self.main().get_by_role("textbox", name="Comment on Paolo’s check-in", exact=True).fill(message)
        self.main().get_by_role("button", name="Send comment", exact=True).click()
        self.wait_for_state("s.comments.length === 1 && s.liked")
        expect(self.main().get_by_text(message, exact=False)).to_be_visible()
        self.assertEqual(self.main().locator(".feed-comment b").count(), 0)
        self.main().get_by_role("button", name="Post a check-in", exact=True).click()
        dialog = self.page.get_by_role("dialog")
        dialog.get_by_role("textbox", name="What’s your little update?", exact=True).fill("Arrived in Manila. Tara, dinner!")
        dialog.get_by_role("combobox", name="Who can see this?", exact=True).select_option("Pamilya")
        dialog.get_by_role("button", name="Post a check-in", exact=True).click()
        self.wait_for_state("s.checkIns.length === 1 && s.checkIns[0].audience === 'Pamilya'")
        self.page.reload()
        expect(self.main().get_by_text("Arrived in Manila. Tara, dinner!", exact=True)).to_be_visible()
        expect(self.main().get_by_role("button", name="Unlike Paolo’s check-in", exact=True)).to_have_attribute("aria-pressed", "true")
        self.main().get_by_role("button", name="1 comment", exact=True).click()
        expect(self.main().get_by_text(message, exact=False)).to_be_visible()

    def test_05_sharing_audience_duration_ongoing_and_stop(self):
        """Sharing respects audience/duration choices and can be stopped after reload."""
        dialog = self.open_share()
        dialog.get_by_role("button", name="Pamilya", exact=True).click()
        dialog.get_by_role("button", name="30 minutes", exact=True).click()
        dialog.get_by_role("textbox", name=re.compile("^Where are you headed")).fill("Home in Makati")
        dialog.get_by_role("button", name="Start demo journey", exact=True).click()
        self.wait_for_state("s.sharing?.audience === 'Pamilya' && s.sharing.durationMinutes === 30")
        expect(self.main().get_by_text("Sharing with Pamilya", exact=True)).to_be_visible()
        self.assertEqual(self.state()["sharing"]["destination"], "Home in Makati")
        dialog = self.open_share()
        dialog.get_by_role("button", name="Barkada", exact=True).click()
        dialog.get_by_role("button", name="Until you stop", exact=True).click()
        dialog.get_by_role("button", name="Update demo journey", exact=True).click()
        self.wait_for_state("s.sharing?.audience === 'Barkada' && s.sharing.durationMinutes === null")
        self.page.reload()
        expect(self.main().get_by_text("Sharing with Barkada", exact=True)).to_be_visible()
        expect(self.main().get_by_text(re.compile("^Until you stop.*Home in Makati"))).to_be_visible()
        self.main().get_by_role("button", name="Stop sharing", exact=True).click()
        self.wait_for_state("s.sharing === null")
        self.page.reload()
        expect(self.main().get_by_role("button", name="Stop sharing", exact=True)).to_have_count(0)

    def test_06_expiry_during_session_and_on_reload(self):
        """Timed sessions expire both while open and when restored from storage."""
        self.page.evaluate("""key => {
            const s = JSON.parse(localStorage.getItem(key));
            s.sharing = { audience: 'Pamilya', durationMinutes: 30, startedAt: Date.now() - 30 * 60000 + 1800, destination: 'Home' };
            localStorage.setItem(key, JSON.stringify(s));
        }""", STORAGE_KEY)
        self.page.reload()
        self.wait_for_state("s.sharing !== null")
        self.wait_for_state("s.sharing === null")
        self.page.evaluate("""key => {
            const s = JSON.parse(localStorage.getItem(key));
            s.sharing = { audience: 'Pamilya', durationMinutes: 30, startedAt: Date.now() - 31 * 60000, destination: 'Home' };
            localStorage.setItem(key, JSON.stringify(s));
        }""", STORAGE_KEY)
        self.page.reload()
        self.wait_for_state("s.sharing === null")
        self.page.evaluate("""key => {
            const s = JSON.parse(localStorage.getItem(key));
            s.sharing = { audience: 'Barkada', durationMinutes: null, startedAt: Date.now() - 48 * 60 * 60000, destination: 'Trip' };
            localStorage.setItem(key, JSON.stringify(s));
        }""", STORAGE_KEY)
        self.page.reload()
        self.wait_for_state("s.sharing?.durationMinutes === null && s.sharing?.audience === 'Barkada'")

    def test_07_invalid_storage_recovers(self):
        """Malformed JSON and invalid shapes reset safely instead of crashing."""
        for invalid in ["{broken JSON", "null", json.dumps({"friendIds": ["unknown-person"]})]:
            with self.subTest(saved_value=invalid):
                self.page.evaluate("([key, raw]) => localStorage.setItem(key, raw)", [STORAGE_KEY, invalid])
                self.page.reload()
                expect(self.page.get_by_role("heading", name="Tara, Mika!", exact=True)).to_be_visible()
                self.wait_for_state("s?.plans?.length === 3 && s.friendIds?.length === 3 && s.sharing === null")

    def test_08_modal_keyboard_and_mobile_layout(self):
        """Dialog focus stays inside, Escape restores focus, and mobile tabs fit."""
        opener = self.main().get_by_role("button", name="Share a journey", exact=True)
        opener.click()
        dialog = self.page.get_by_role("dialog")
        close = dialog.get_by_role("button", name="Close dialog", exact=True)
        submit = dialog.get_by_role("button", name="Start demo journey", exact=True)
        expect(close).to_be_focused()
        close.press("Shift+Tab")
        expect(submit).to_be_focused()
        submit.press("Tab")
        expect(close).to_be_focused()
        close.press("Escape")
        expect(dialog).to_have_count(0)
        expect(opener).to_be_focused()
        self.page.set_viewport_size({"width": 375, "height": 812})
        for name in ["Home", "Map", "Plans", "Friends"]:
            self.navigate(name)
            expect(self.page.get_by_role("navigation", name="Mobile navigation", exact=True)).to_be_visible()
            dimensions = self.page.evaluate("({width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth})")
            self.assertLessEqual(dimensions["scrollWidth"], dimensions["width"], f"Horizontal overflow on {name}: {dimensions}")
        self.navigate("Home")
        dialog = self.open_share()
        self.assertLessEqual(dialog.bounding_box()["width"], 375)
        self.page.keyboard.press("Escape")

    def test_09_accepting_friend_stops_active_sharing(self):
        """A new friendship cannot silently expand an existing sharing audience."""
        self.assertEqual(self.state()["requestStatus"], "pending")
        dialog = self.open_share()
        expect(dialog.get_by_text("3 friends in this sample circle", exact=True)).to_be_visible()
        dialog.get_by_role("button", name="Start demo journey", exact=True).click()
        self.wait_for_state("s.sharing !== null && !s.friendIds.includes('ana')")
        self.navigate("Friends")
        self.main().get_by_role("button", name="Accept request", exact=True).click()
        self.wait_for_state("s.friendIds.includes('ana') && s.requestStatus === 'accepted' && s.sharing === null")
        self.page.reload()
        self.wait_for_state("s.friendIds.includes('ana') && s.sharing === null")
        self.navigate("Map")
        expect(self.main().get_by_role("button", name="Stop sharing", exact=True)).to_have_count(0)
        dialog = self.open_share()
        expect(dialog.get_by_text("4 friends in this sample circle", exact=True)).to_be_visible()
        self.page.keyboard.press("Escape")
        self.assertIsNone(self.state()["sharing"])

    def test_10_empty_circle_cannot_start_sharing(self):
        """The start control reflects actual eligible circle viewers."""
        self.navigate("Friends")
        self.main().get_by_role("button", name="Options for Paolo", exact=True).click()
        self.main().get_by_role("button", name="Remove friend", exact=True).click()
        self.wait_for_state("!s.friendIds.includes('paolo')")
        dialog = self.open_share()
        dialog.get_by_role("button", name="Pamilya", exact=True).click()
        expect(dialog.get_by_text("No friends in this circle yet. Add a friend first.", exact=True)).to_be_visible()
        expect(dialog.get_by_role("button", name="Start demo journey", exact=True)).to_be_disabled()
        dialog.get_by_role("textbox", name=re.compile("^Where are you headed")).fill("Home")
        dialog.get_by_role("textbox", name=re.compile("^Where are you headed")).press("Enter")
        expect(dialog).to_be_visible()
        self.assertIsNone(self.state()["sharing"])
        dialog.get_by_role("button", name="Close friends", exact=True).click()
        expect(dialog.get_by_text("2 friends in this sample circle", exact=True)).to_be_visible()
        expect(dialog.get_by_role("button", name="Start demo journey", exact=True)).to_be_enabled()
        self.page.keyboard.press("Escape")

    def test_11_modal_focus_after_action_becomes_disabled(self):
        """Disabling a clicked request action must not let keyboard focus escape."""
        self.navigate("Friends")
        self.main().get_by_role("button", name="Add friends", exact=True).click()
        dialog = self.page.get_by_role("dialog")
        dialog.get_by_role("textbox", name="Name or username", exact=True).fill("Nico")
        dialog.get_by_role("button", name="Add friend", exact=True).click()
        expect(dialog.get_by_role("button", name="Request sent", exact=True)).to_be_disabled()
        for key in ["Tab", "Shift+Tab", "Tab", "Tab", "Tab", "Shift+Tab"]:
            self.page.keyboard.press(key)
            self.assertTrue(dialog.evaluate("element => element.contains(document.activeElement)"), f"Focus escaped after {key}")
        self.page.keyboard.press("Escape")
        expect(dialog).to_have_count(0)

    def test_12_skip_link_preserves_selected_screen(self):
        """Skipping to content must focus the current view without changing the route."""
        self.navigate("Plans")
        self.assertEqual(self.page.evaluate("location.hash"), "#plans")
        skip_link = self.page.get_by_role("link", name="Skip to content", exact=True)
        skip_link.focus()
        skip_link.press("Enter")
        expect(self.main()).to_be_focused()
        self.assertEqual(self.page.evaluate("location.hash"), "#plans")
        expect(self.main().get_by_role("heading", name="Tara, let’s make plans.", exact=True)).to_be_visible()


if __name__ == "__main__":
    unittest.main(verbosity=2)
