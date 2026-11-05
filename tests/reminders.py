"""Plan calendar/reminder browser contracts with intercepted fictional accounts.

Use the two local servers documented in accounts.py. Calendar files are read
from Playwright downloads; no external calendar, email, push, or hosted writes
are used. PostgreSQL authorization and dispatch are tested separately.
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
FUTURE = "2099-11-05T07:00:00+00:00"


class MockRemindersService(social.MockSocialService):
    """UI contract fixture, not an authorization or cron implementation."""
    def __init__(self):
        super().__init__()
        self.current_social()["plans"][0]["starts_at"] = FUTURE
        self.reminders_by_user = {}
        self.reminder_error = None
        self.reminder_mutation_error = None
        self.calendar_error = None
        self.calendar_revoked_ids = set()
        self.hold_reminder_snapshot = False
        self.held_reminder_snapshots = []
        self.hold_reminder_save = False
        self.held_reminder_saves = []
        self.hold_calendar = False
        self.held_calendars = []

    def current_reminders(self):
        return self.reminders_by_user.setdefault(self.user_id, {})

    def reminder_snapshot(self):
        return {"reminders": [{"plan_id": plan_id, "minutes_before": sorted(minutes)}
                              for plan_id, minutes in self.current_reminders().items() if minutes]}

    def find_plan(self, plan_id):
        plans = self.current_social()["plans"] + self.target_plans_by_user.get(self.user_id, [])
        return next((plan for plan in plans if plan["id"] == plan_id), None)

    def calendar_snapshot(self, plan_id):
        plan = None if plan_id in self.calendar_revoked_ids else self.find_plan(plan_id)
        return {"plan": {key: plan[key] for key in ["id", "title", "place", "starts_at", "created_at"]} if plan else None,
                "reminder_minutes": list(self.current_reminders().get(plan_id, [])) if plan else []}

    def handle(self, route):
        request = route.request
        url = urlparse(request.url)
        name = url.path.split("/")[-1]
        if request.method == "POST" and name in ["delete_social_plan", "set_social_attendance"]:
            body = request.post_data_json or {}
            if name == "delete_social_plan" or body.get("going") is False:
                plan_id = body.get("plan_id")
                owners = self.reminders_by_user if name == "delete_social_plan" else {self.user_id: self.current_reminders()}
                for preferences in owners.values():
                    preferences.pop(plan_id, None)
                for owner, events in self.inbox_by_user.items():
                    self.inbox_by_user[owner] = [event for event in events if not (event["kind"] == "plan_reminder" and event["plan_id"] == plan_id)]
        names = {"plan_reminders_snapshot", "set_plan_reminders", "plan_calendar_snapshot"}
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
            respond({"code": code, "message": "Reminder or plan unavailable"}, 404 if code == "PGRST202" else 403)

        if name == "plan_reminders_snapshot":
            if self.reminder_error:
                fail(self.reminder_error)
            elif self.hold_reminder_snapshot:
                self.held_reminder_snapshots.append((route, self.reminder_snapshot()))
                self.hold_reminder_snapshot = False
            else:
                respond(self.reminder_snapshot())
        elif name == "set_plan_reminders":
            if self.reminder_mutation_error:
                fail(self.reminder_mutation_error)
            elif self.hold_reminder_save:
                self.held_reminder_saves.append((route, self.user_id, body.copy()))
                self.hold_reminder_save = False
            else:
                self.current_reminders()[body["plan_id"]] = list(body["reminder_minutes"])
                respond()
        elif name == "plan_calendar_snapshot":
            if self.calendar_error:
                fail(self.calendar_error)
            elif self.hold_calendar:
                self.held_calendars.append((route, self.calendar_snapshot(body["plan_id"])))
                self.hold_calendar = False
            else:
                respond(self.calendar_snapshot(body["plan_id"]))


class ReminderBrowserTests(unittest.TestCase):
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
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 1050}, reduced_motion="reduce", accept_downloads=True)
        self.service = MockRemindersService()
        self.errors = []
        self.unexpected_remote_hosts = []
        self.downloads = []
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
        self.page.on("download", lambda download: self.downloads.append(download))

    def navigate(self, tab):
        nav = "Mobile navigation" if self.page.viewport_size["width"] <= 640 else "Main navigation"
        self.page.get_by_role("navigation", name=nav, exact=True).get_by_role("button", name=re.compile(rf"^{tab}(?:$|\s)")).click()

    def sign_in_plans(self):
        self.sign_in_feed()
        self.navigate("Plans")
        expect(self.card()).to_be_visible()

    def card(self, plan_id=social.PLAN_ID):
        return self.page.locator(f"#activity-plan-{plan_id}")

    def tools(self, plan_id=social.PLAN_ID, button="Add to calendar"):
        self.card(plan_id).get_by_role("button", name=button, exact=True).click()
        dialog = self.page.get_by_role("dialog", name="Calendar & reminders", exact=True)
        expect(dialog).to_be_visible()
        return dialog

    def close_tools(self):
        dialog = self.page.get_by_role("dialog", name="Calendar & reminders", exact=True)
        if dialog.count():
            dialog.get_by_role("button", name="Close dialog", exact=True).click()

    def saved(self, dialog):
        dialog.get_by_role("button", name="Save reminders", exact=True).click()
        expect(dialog.get_by_text("Your reminder choices were saved.", exact=True)).to_be_visible()

    def download(self, dialog):
        with self.page.expect_download() as download:
            dialog.get_by_role("button", name="Download calendar event", exact=True).click()
        result = download.value
        self.assertTrue(result.suggested_filename.endswith(".ics"))
        return Path(result.path()).read_bytes().decode("utf-8")

    def own_plan(self, plan_id=OWN_PLAN, title="Maria’s private plan"):
        plan = {"id": plan_id, "owner": self.service.profile.copy(), "title": title,
                "place": "Pamilya café", "starts_at": FUTURE, "kind": "coffee", "created_at": accounts.NOW,
                "invitees": [], "attendees": [self.service.profile.copy()]}
        self.service.current_social()["plans"].append(plan)
        return plan

    def held(self, queue):
        deadline = time.monotonic() + 5
        while not queue and time.monotonic() < deadline:
            self.page.wait_for_timeout(10)
        self.assertTrue(queue, "Expected intercepted request was not queued")
        return queue.pop()

    def switch_account_in_second_tab(self):
        second = self.context.new_page()
        second.set_default_timeout(9000)
        second.on("pageerror", lambda error: self.errors.append(str(error)))
        second.goto(accounts.ACCOUNT_URL)
        expect(second.get_by_role("heading", name="Tara, Maria!", exact=True)).to_be_visible()
        second.get_by_role("button", name="Open your profile", exact=True).click()
        account = second.get_by_role("dialog", name="Your TARA account", exact=True)
        account.get_by_role("button", name="Sign out", exact=True).click()
        expect(self.page.get_by_role("dialog", name="Calendar & reminders", exact=True)).to_have_count(0)
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
        self.page.screenshot(path=f"test-results/reminders-{name}.png")

    def test_01_calendar_download_is_fresh_private_unicode_and_utc_without_default_alarms(self):
        self.sign_in_plans()
        dialog = self.tools()
        expect(dialog.get_by_role("checkbox", name="1 day before", exact=True)).not_to_be_checked()
        expect(dialog.get_by_role("checkbox", name="1 hour before", exact=True)).not_to_be_checked()
        expect(dialog).to_contain_text("copies")
        expect(dialog).to_contain_text("cancelled")
        # The export must revalidate live data rather than reuse the card copy.
        plan = self.service.find_plan(social.PLAN_ID)
        plan["title"] = "Merienda, pamilya; kumustá 🌻"
        plan["place"] = "Café\\Garden, BGC; Manila"
        text = self.download(dialog)
        logical = text.replace("\r\n ", "")
        self.assertIn("DTSTART:20991105T070000Z\r\n", logical)
        self.assertIn("SUMMARY:Merienda\\, pamilya\\; kumustá 🌻\r\n", logical)
        self.assertIn("LOCATION:Café\\\\Garden\\, BGC\\; Manila\r\n", logical)
        self.assertIn("CLASS:PRIVATE\r\n", logical)
        self.assertEqual(logical.count("BEGIN:VEVENT"), 1)
        self.assertNotIn("BEGIN:VALARM", text)
        for private_value in ["ATTENDEE", "ORGANIZER", self.service.email, "bea_real_test", "maria_test", accounts.USER_ID, accounts.FRIEND_ID]:
            self.assertNotIn(private_value, text)
        self.assertEqual(self.rpc_body("plan_calendar_snapshot"), {"plan_id": social.PLAN_ID})

    def test_02_personal_preferences_persist_and_calendar_contains_only_chosen_alarms(self):
        self.sign_in_plans()
        dialog = self.tools(button="Remind me")
        dialog.get_by_role("checkbox", name="1 day before", exact=True).check()
        dialog.get_by_role("checkbox", name="1 hour before", exact=True).check()
        self.saved(dialog)
        self.assertEqual(self.rpc_body("set_plan_reminders")["plan_id"], social.PLAN_ID)
        self.assertCountEqual(self.rpc_body("set_plan_reminders")["reminder_minutes"], [60, 1440])
        text = self.download(dialog)
        self.assertEqual(text.count("BEGIN:VALARM"), 2)
        self.assertIn("TRIGGER:-P1D", text)
        self.assertIn("TRIGGER:-PT1H", text)
        self.close_tools()
        self.page.reload()
        dialog = self.tools(button="Reminders on")
        expect(dialog.get_by_role("checkbox", name="1 day before", exact=True)).to_be_checked()
        expect(dialog.get_by_role("checkbox", name="1 hour before", exact=True)).to_be_checked()
        dialog.get_by_role("checkbox", name="1 day before", exact=True).uncheck()
        dialog.get_by_role("checkbox", name="1 hour before", exact=True).uncheck()
        self.saved(dialog)
        self.assertEqual(self.rpc_body("set_plan_reminders"), {"plan_id": social.PLAN_ID, "reminder_minutes": []})
        self.assertNotIn("BEGIN:VALARM", self.download(dialog))
        self.assertFalse(self.page.evaluate("Object.values(localStorage).some(value => value.includes('reminder_minutes'))"))

    def test_03_own_and_invited_plan_preferences_are_independent(self):
        self.own_plan()
        self.sign_in_plans()
        dialog = self.tools(OWN_PLAN)
        dialog.get_by_role("checkbox", name="1 day before", exact=True).check()
        self.saved(dialog)
        self.close_tools()
        dialog = self.tools()
        expect(dialog.get_by_role("checkbox", name="1 day before", exact=True)).not_to_be_checked()
        dialog.get_by_role("checkbox", name="1 hour before", exact=True).check()
        self.saved(dialog)
        self.assertEqual(self.service.current_reminders(), {OWN_PLAN: [1440], social.PLAN_ID: [60]})
        self.close_tools()
        expect(self.card(OWN_PLAN).get_by_role("button", name="Reminders on", exact=True)).to_be_visible()
        expect(self.card().get_by_role("button", name="Reminders on", exact=True)).to_be_visible()

    def test_04_failed_reminder_save_keeps_user_choice_and_recovers_after_refresh(self):
        self.sign_in_plans()
        dialog = self.tools()
        dialog.get_by_role("checkbox", name="1 hour before", exact=True).check()
        self.service.reminder_mutation_error = "42501"
        dialog.get_by_role("button", name="Save reminders", exact=True).click()
        expect(dialog.get_by_role("alert").last).to_be_visible()
        self.assertNotIn(social.PLAN_ID, self.service.current_reminders())
        self.service.reminder_mutation_error = None
        dialog.get_by_role("button", name="Refresh reminders", exact=True).click()
        expect(dialog.get_by_role("checkbox", name="1 hour before", exact=True)).to_be_checked()
        expect(dialog.get_by_role("button", name="Save reminders", exact=True)).to_be_enabled()
        self.saved(dialog)
        self.assertEqual(self.service.current_reminders()[social.PLAN_ID], [60])

    def test_05_calendar_export_rechecks_revoked_or_missing_access_before_download(self):
        self.sign_in_plans()
        dialog = self.tools()
        self.service.calendar_revoked_ids.add(social.PLAN_ID)
        dialog.get_by_role("button", name="Download calendar event", exact=True).click()
        expect(dialog.get_by_role("alert").last).to_be_visible()
        self.assertEqual(self.downloads, [])
        self.assertEqual(self.rpc_body("plan_calendar_snapshot"), {"plan_id": social.PLAN_ID})
        self.service.calendar_revoked_ids.clear()
        self.service.calendar_error = "42501"
        dialog.get_by_role("button", name="Download calendar event", exact=True).click()
        expect(dialog.get_by_role("alert").last).to_be_visible()
        self.assertEqual(self.downloads, [])

    def test_06_late_calendar_response_cannot_download_another_accounts_plan(self):
        self.sign_in_plans()
        dialog = self.tools()
        self.service.hold_calendar = True
        dialog.get_by_role("button", name="Download calendar event", exact=True).click()
        pending, snapshot = self.held(self.service.held_calendars)
        second = self.switch_account_in_second_tab()
        pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(snapshot))
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        self.assertEqual(self.downloads, [])
        expect(self.page.get_by_text("Real lunch invitation", exact=True)).to_have_count(0)
        second.close()

    def test_07_late_preference_snapshot_cannot_restore_the_previous_account(self):
        self.service.current_reminders()[social.PLAN_ID] = [60, 1440]
        self.sign_in_plans()
        dialog = self.tools()
        self.service.hold_reminder_snapshot = True
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")
        pending, snapshot = self.held(self.service.held_reminder_snapshots)
        second = self.switch_account_in_second_tab()
        pending.fulfill(status=200, headers=social.HEADERS, body=json.dumps(snapshot))
        self.assertEqual(self.downloads, [])
        expect(self.page.get_by_role("button", name="Reminders on", exact=True)).to_have_count(0)
        self.assertEqual(self.service.current_reminders(), {})
        second.close()

    def test_08_late_save_does_not_set_preferences_or_messages_for_the_new_account(self):
        self.sign_in_plans()
        dialog = self.tools()
        dialog.get_by_role("checkbox", name="1 hour before", exact=True).check()
        self.service.hold_reminder_save = True
        dialog.get_by_role("button", name="Save reminders", exact=True).click()
        pending, owner, body = self.held(self.service.held_reminder_saves)
        self.assertEqual(owner, accounts.USER_ID)
        second = self.switch_account_in_second_tab()
        self.service.reminders_by_user.setdefault(owner, {})[body["plan_id"]] = body["reminder_minutes"]
        pending.fulfill(status=200, headers=social.HEADERS, body="null")
        expect(self.page.get_by_text("Your reminder choices were saved.", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("button", name="Reminders on", exact=True)).to_have_count(0)
        self.assertEqual(self.service.current_reminders(), {})
        second.close()

    def test_09_personal_reminder_inbox_links_to_exact_plan_beyond_the_list(self):
        plan = self.own_plan(OLD_PLAN, "An older calendar plan")
        self.service.current_social()["plans"] = [p for p in self.service.current_social()["plans"] if p["id"] != OLD_PLAN]
        self.service.target_plans_by_user.setdefault(accounts.USER_ID, []).append(plan)
        item = self.service.add_activity("plan_reminder", actor_id=accounts.USER_ID, plan_id=OLD_PLAN,
                                         plan_title=plan["title"], reminder_minutes=60, plan_starts_at=plan["starts_at"])
        self.sign_in_plans()
        expect(self.card(OLD_PLAN)).to_have_count(0)
        self.page.get_by_role("button", name="Open notifications", exact=True).click()
        inbox = self.page.get_by_role("dialog", name="Activity inbox", exact=True)
        button = inbox.get_by_role("button").filter(has_text="An older calendar plan")
        expect(button).to_be_visible()
        button.click()
        expect(self.card(OLD_PLAN)).to_be_focused()
        expect(self.card(OLD_PLAN).get_by_role("button", name="Add to calendar", exact=True)).to_be_visible()
        self.assertEqual(self.rpc_body("activity_target_snapshot"), {"post_id": None, "plan_id": OLD_PLAN})
        self.assertEqual(self.rpc_body("mark_activity_read"), {"activity_ids": [item["id"]]})
        self.assertIsNotNone(item["read_at"])

    def test_10_cancelling_a_plan_removes_tools_and_leaving_stops_personal_reminders(self):
        self.own_plan()
        self.service.current_reminders()[OWN_PLAN] = [60]
        self.sign_in_plans()
        self.card(OWN_PLAN).get_by_role("button", name="Cancel plan", exact=True).click()
        dialog = self.page.get_by_role("dialog", name="Cancel Maria’s private plan?", exact=True)
        dialog.get_by_role("button", name="Yes, cancel plan", exact=True).click()
        expect(dialog).to_have_count(0)
        expect(self.card(OWN_PLAN)).to_have_count(0)
        self.assertNotIn(OWN_PLAN, self.service.current_reminders())
        self.service.current_reminders()[social.PLAN_ID] = [60]
        self.service.find_plan(social.PLAN_ID)["attendees"].append(self.service.profile.copy())
        self.page.get_by_role("button", name="Refresh plans", exact=True).click()
        self.card().get_by_role("button", name="Leave Real lunch invitation", exact=True).click()
        expect(self.card().get_by_role("button", name="Join Real lunch invitation", exact=True)).to_be_visible()
        self.assertNotIn(social.PLAN_ID, self.service.current_reminders())
        expect(self.card().get_by_role("button", name="Remind me", exact=True)).to_be_visible()

    def test_11_passed_thresholds_cannot_be_newly_enabled_but_saved_choices_can_be_disabled(self):
        plan = self.service.find_plan(social.PLAN_ID)
        plan["starts_at"] = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
        self.service.current_reminders()[social.PLAN_ID] = [60]
        self.sign_in_plans()
        dialog = self.tools(button="Reminders on")
        expect(dialog.get_by_role("checkbox", name="1 day before", exact=True)).to_be_disabled()
        hour = dialog.get_by_role("checkbox", name="1 hour before", exact=True)
        expect(hour).to_be_checked()
        expect(hour).to_be_enabled()
        hour.uncheck()
        self.saved(dialog)
        self.assertEqual(self.rpc_body("set_plan_reminders"), {"plan_id": social.PLAN_ID, "reminder_minutes": []})
        expect(hour).to_be_disabled()
        text = self.download(dialog)
        self.assertNotIn("BEGIN:VALARM", text)

    def test_12_mobile_both_themes_keep_calendar_copy_notice_keyboard_and_controls_usable(self):
        self.sign_in_plans()
        for dark in (False, True):
            toggle = self.page.get_by_role("switch", name="Dark mode", exact=True)
            if (toggle.get_attribute("aria-checked") == "true") != dark:
                toggle.click()
            for width in (375, 320):
                self.page.set_viewport_size({"width": width, "height": 812})
                opener = self.card().get_by_role("button", name="Add to calendar", exact=True)
                opener.click()
                dialog = self.page.get_by_role("dialog", name="Calendar & reminders", exact=True)
                expect(dialog).to_be_visible()
                expect(dialog).to_contain_text("copies")
                self.assertLessEqual(dialog.bounding_box()["width"], width)
                self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth"), width)
                close = dialog.get_by_role("button", name="Close dialog", exact=True)
                close.focus()
                close.press("Shift+Tab")
                expect(dialog.get_by_role("button", name="Download calendar event", exact=True)).to_be_focused()
                self.screenshot(f"{'dark' if dark else 'light'}-{width}")
                self.page.keyboard.press("Escape")
                expect(dialog).to_have_count(0)
                expect(opener).to_be_focused()

    def test_13_missing_reminder_upgrade_isolated_from_existing_plans_and_recovers(self):
        self.service.reminder_error = "PGRST202"
        self.sign_in_plans()
        expect(self.card().get_by_role("button", name="Join Real lunch invitation", exact=True)).to_be_visible()
        dialog = self.tools()
        expect(dialog.get_by_role("alert").first).to_be_visible()
        self.service.reminder_error = None
        dialog.get_by_role("button", name="Refresh reminders", exact=True).click()
        expect(dialog.get_by_role("checkbox", name="1 hour before", exact=True)).to_be_enabled()
        expect(dialog.get_by_role("checkbox", name="1 day before", exact=True)).not_to_be_checked()


if __name__ == "__main__":
    unittest.main(verbosity=2)
