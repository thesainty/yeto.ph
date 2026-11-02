"""Profile username suggestion checks using local Vite and intercepted HTTP.

Run the two servers documented in accounts.py, then: python tests/usernames.py
No hosted signups, accounts, SQL, or profile changes are made. The database
trigger's new-account defaults are covered separately by username-database.test.mjs.
"""
import re
import unittest
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect
import accounts


FUN_USERNAME = re.compile(r"^[a-z]+_[a-z]+_[0-9]{4}$")


class UsernameBrowserTests(unittest.TestCase):
    setUpClass = accounts.AccountIntegrationTests.__dict__["setUpClass"]
    tearDownClass = accounts.AccountIntegrationTests.__dict__["tearDownClass"]
    setUp = accounts.AccountIntegrationTests.setUp
    tearDown = accounts.AccountIntegrationTests.tearDown
    visit = accounts.AccountIntegrationTests.visit
    account = accounts.AccountIntegrationTests.account
    open_account = accounts.AccountIntegrationTests.open_account
    sign_in = accounts.AccountIntegrationTests.sign_in
    submit_sign_in = accounts.AccountIntegrationTests.submit_sign_in
    close_account = accounts.AccountIntegrationTests.close_account

    def username(self):
        return self.account().get_by_role("textbox", name=re.compile(r"^Username(?:$|\s)"))

    def suggest(self):
        self.account().get_by_role("button", name="Suggest a fun username", exact=True).click()
        expect(self.username()).to_have_value(FUN_USERNAME)
        return self.username().input_value()

    def test_01_existing_username_stays_saved_until_explicit_profile_save(self):
        """A suggestion is an unsaved draft; an existing account is never renamed silently."""
        dialog = self.sign_in()
        expect(self.username()).to_have_value("maria_test")
        self.assertEqual(self.service.matching("/rest/v1/profiles", "PATCH"), [])
        suggestion = self.suggest()
        expect(dialog.get_by_role("status")).to_contain_text("Suggestion ready. Save profile to use it.")
        expect(dialog.get_by_role("textbox", name="Display name", exact=True)).to_have_value("Maria Test")
        self.assertEqual(self.service.matching("/rest/v1/profiles", "PATCH"), [])
        self.assertEqual(self.service.profile["username"], "maria_test")
        dialog.get_by_role("button", name="Save profile", exact=True).click()
        expect(dialog.get_by_role("status")).to_contain_text("Profile saved")
        self.assertEqual(self.service.matching("/rest/v1/profiles", "PATCH")[-1]["body"], {
            "username": suggestion, "display_name": "Maria Test",
        })
        self.close_account()
        expect(self.page.locator(".sidebar-profile")).to_contain_text(f"@{suggestion}")
        self.page.reload()
        expect(self.page.locator(".sidebar-profile")).to_contain_text(f"@{suggestion}")
        self.open_account()
        expect(self.username()).to_have_value(suggestion)
        expect(self.account().get_by_role("textbox", name="Display name", exact=True)).to_have_value("Maria Test")

    def test_02_taken_suggestion_keeps_draft_and_can_be_replaced(self):
        """A username collision neither overwrites the saved profile nor loses the draft."""
        self.sign_in()
        rejected = []

        def reject_first_patch(route):
            request = route.request
            if request.method == "PATCH" and not rejected:
                url = urlparse(request.url)
                call = {
                    "path": url.path, "query": parse_qs(url.query),
                    "method": request.method, "body": request.post_data_json,
                }
                rejected.append(call)
                self.service.calls.append(call)
                route.fulfill(status=409, headers={
                    "access-control-allow-origin": "*",
                    "content-type": "application/json",
                }, body='{"code":"23505","message":"username already exists"}')
            else:
                self.service.handle(route)

        self.context.route(f"**{accounts.MOCK_HOST}/rest/v1/profiles**", reject_first_patch)
        suggestion = self.suggest()
        self.account().get_by_role("button", name="Save profile", exact=True).click()
        expect(self.account().get_by_role("alert")).to_contain_text("already exists")
        expect(self.username()).to_have_value(suggestion)
        expect(self.account().get_by_role("textbox", name="Display name", exact=True)).to_have_value("Maria Test")
        self.assertEqual(self.service.profile["username"], "maria_test")
        replacement = self.suggest()
        self.account().get_by_role("button", name="Save profile", exact=True).click()
        expect(self.account().get_by_role("status")).to_contain_text("Profile saved")
        self.assertEqual(self.service.profile["username"], replacement)
        self.assertEqual(self.service.profile["display_name"], "Maria Test")
        self.assertEqual(len(rejected), 1)

    def test_03_mobile_draft_is_discarded_on_close_and_account_switch(self):
        """Unsaved suggestions fit a phone and cannot become another account's username."""
        self.page.set_viewport_size({"width": 375, "height": 812})
        self.sign_in()
        self.suggest()
        self.account().get_by_role("button", name="Suggest a fun username", exact=True).scroll_into_view_if_needed()
        expect(self.account().get_by_role("button", name="Suggest a fun username", exact=True)).to_be_visible()
        dimensions = self.page.evaluate("({width: innerWidth, scrollWidth: document.documentElement.scrollWidth})")
        self.assertLessEqual(dimensions["scrollWidth"], dimensions["width"])
        self.assertLessEqual(self.account().bounding_box()["width"], 375)
        self.close_account()
        self.open_account()
        expect(self.username()).to_have_value("maria_test")
        self.suggest()
        self.account().get_by_role("button", name="Sign out", exact=True).click()
        expect(self.account().get_by_role("button", name="Sign in to TARA", exact=True)).to_be_visible()
        self.service.switch_user(accounts.SECOND_USER_ID, "Luna Other", "luna_other", "luna@example.test")
        self.submit_sign_in(self.account())
        expect(self.username()).to_have_value("luna_other")
        expect(self.account().get_by_role("textbox", name="Display name", exact=True)).to_have_value("Luna Other")
        self.assertEqual(self.service.matching("/rest/v1/profiles", "PATCH"), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
