import unittest
from backend.epic_helper import (
    build_shortcuts_vdf,
    get_epic_updates_and_downloads,
    get_free_games,
)


class TestEpicHelper(unittest.TestCase):
    def test_build_shortcuts_vdf_binary_structure(self):
        data = build_shortcuts_vdf(
            [
                {
                    "AppName": "Test Epic Game",
                    "Exe": '"/usr/bin/legendary"',
                    "StartDir": '"/usr/bin"',
                    "LaunchOptions": "launch test_app",
                }
            ]
        )
        self.assertTrue(data.startswith(b"\x00shortcuts\x00"))
        self.assertIn(b"Test Epic Game\x00", data)
        self.assertIn(b"launch test_app\x00", data)
        self.assertTrue(data.endswith(b"\x08\x08"))

    def test_get_free_games_returns_checkout_url(self):
        res = get_free_games()
        self.assertIn("ok", res)
        self.assertIn("games", res)
        self.assertIsInstance(res["games"], list)
        if res["games"]:
            g = res["games"][0]
            self.assertIn("checkoutUrl", g)
            self.assertIn("store/purchase", g["checkoutUrl"])

    def test_get_epic_updates_and_downloads_structure(self):
        res = get_epic_updates_and_downloads(check_remote=False)
        self.assertTrue(res.get("ok"))
        self.assertIn("installedGames", res)
        self.assertIn("pendingUpdates", res)
        self.assertIn("activeTransfers", res)


if __name__ == "__main__":
    unittest.main()
