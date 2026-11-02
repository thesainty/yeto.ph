"""Pilot guide browser checks with local servers and intercepted account HTTP.

Run the two servers documented in accounts.py, then: python tests/pilot.py
Clipboard access is stubbed; no invitations, hosted writes, or SQL are sent.
"""
import unittest

from playwright.sync_api import expect
import accounts
import social


class PilotBrowserTests(unittest.TestCase):
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

    def guide(self):
        opener = self.page.get_by_role("button", name="Pilot guide", exact=True)
        opener.click()
        dialog = self.page.get_by_role("dialog", name="Pilot guide", exact=True)
        expect(dialog).to_be_visible()
        return opener, dialog

    def assert_no_content_writes(self):
        writes = [call for call in self.service.calls
                  if call["path"].startswith("/rest/v1/rpc/")
                  and call["path"] not in ["/rest/v1/rpc/social_snapshot", "/rest/v1/rpc/audience_circles_snapshot", "/rest/v1/rpc/activity_inbox_snapshot"]]
        self.assertEqual(writes, [], "Reading/copying the guide must not mutate content or connections")

    def test_01_anonymous_guide_copy_and_escape_preserve_demo(self):
        self.context.add_init_script("""
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: {writeText: async text => { window.__pilotCopied = text; }}
            });
        """)
        self.visit(accounts.DEMO_URL)
        before = self.page.evaluate("localStorage.getItem('yeto-demo-v1')")
        opener, dialog = self.guide()
        expect(dialog.get_by_role("heading", name="Start with your real account", exact=True)).to_be_visible()
        expect(dialog).to_contain_text("Signed-in Friends, Home updates, and Plans use real data.")
        expect(dialog).to_contain_text("The anonymous preview, Map, and journey tools are demos.")
        template = dialog.get_by_role("textbox", name="Feedback template", exact=True)
        expect(template).to_have_attribute("readonly", "")
        expect(template).to_have_value("TARA pilot feedback\nDevice and browser:\nWhat I was trying to do:\nSteps to reproduce:\nWhat I expected:\nWhat actually happened:\nWhat felt easy or confusing:\n")
        dialog.get_by_role("button", name="Copy feedback template", exact=True).click()
        expect(dialog.get_by_role("status")).to_contain_text("Template copied.")
        self.assertEqual(self.page.evaluate("window.__pilotCopied"), template.input_value())
        self.page.keyboard.press("Escape")
        expect(dialog).to_have_count(0)
        expect(opener).to_be_focused()
        self.assertEqual(self.page.evaluate("localStorage.getItem('yeto-demo-v1')"), before)
        self.assertEqual(self.service.calls, [], "Unconfigured guide must not contact an account service")

    def test_02_signedin_guide_fallback_and_account_transition_are_readonly(self):
        self.context.add_init_script("""
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: {writeText: async () => { throw new Error('Mock clipboard unavailable'); }}
            });
        """)
        self.sign_in_feed()
        _, dialog = self.guide()
        expect(dialog).to_contain_text("Adding friends or joining plans never turns on location sharing.")
        dialog.get_by_role("button", name="Copy feedback template", exact=True).click()
        expect(dialog.get_by_role("status")).to_contain_text("Select and copy the template below")
        expect(dialog.get_by_role("textbox", name="Feedback template", exact=True)).to_be_visible()
        dialog.get_by_role("button", name="Open your account", exact=True).click()
        expect(dialog).to_have_count(0)
        expect(self.account()).to_be_visible()
        expect(self.account().get_by_label("Display name", exact=True)).to_have_value("Maria Test")
        expect(self.page.get_by_role("dialog")).to_have_count(1)
        self.assert_no_content_writes()

    def test_03_mobile_guide_fits_and_opens_real_signin(self):
        self.page.set_viewport_size({"width": 375, "height": 812})
        self.visit(accounts.ACCOUNT_URL)
        _, dialog = self.guide()
        self.assertLessEqual(dialog.bounding_box()["width"], 375)
        dimensions = self.page.evaluate("({width: innerWidth, scrollWidth: document.documentElement.scrollWidth})")
        self.assertLessEqual(dimensions["scrollWidth"], dimensions["width"], "Guide must fit mobile width")
        dialog.get_by_role("button", name="Copy feedback template", exact=True).scroll_into_view_if_needed()
        expect(dialog.get_by_role("textbox", name="Feedback template", exact=True)).to_be_visible()
        dialog.get_by_role("button", name="Open your account", exact=True).click()
        expect(dialog).to_have_count(0)
        expect(self.account().get_by_label("Email address", exact=True)).to_be_visible()
        expect(self.page.get_by_role("dialog")).to_have_count(1)
        self.assert_no_content_writes()


if __name__ == "__main__":
    unittest.main(verbosity=2)
