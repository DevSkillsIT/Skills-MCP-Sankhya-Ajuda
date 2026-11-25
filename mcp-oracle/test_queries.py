import unittest
from queries import prepare
class QueryTests(unittest.TestCase):
    def test_binds(self):
        sql, binds = prepare("columns", "sankhya", "tgfcab")
        self.assertEqual(binds, {"owner":"SANKHYA","table_name":"TGFCAB"})
        self.assertNotIn("TGFCAB", sql)
        self.assertIn("ROWNUM <= 200", sql)
    def test_reject_invalid_identifier(self):
        for name in ("x' OR 1=1", "a.b", "a;DROP TABLE x", ""):
            with self.assertRaises(ValueError):
                prepare("columns", "SANKHYA", name)
    def test_fixed_query_only(self):
        with self.assertRaises(KeyError):
            prepare("delete", "SANKHYA", "TGFCAB")
if __name__ == "__main__":
    unittest.main()
