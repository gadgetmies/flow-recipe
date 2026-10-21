import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('pages_tree', Path(__file__).with_name('pages-tree.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.site = Path(self.tmp.name) / 'site'
        self.incoming = Path(self.tmp.name) / 'incoming'
        self.site.mkdir()
        self.incoming.mkdir()
        (self.incoming / 'index.html').write_text('new build')
        (self.incoming / 'static').mkdir()
        (self.incoming / 'static' / 'app.js').write_text('asset')

    def test_production_preserves_previews_and_removes_old_assets(self):
        module.update(self.site, self.incoming, 'preview', '12')
        (self.site / 'old.js').write_text('stale')
        (self.site / '.git').write_text('worktree metadata')
        module.update(self.site, self.incoming, 'production')
        self.assertEqual((self.site / 'index.html').read_text(), 'new build')
        self.assertTrue((self.site / 'previews/pr-12/index.html').exists())
        self.assertTrue((self.site / '.git').exists())
        self.assertFalse((self.site / 'old.js').exists())

    def test_preview_update_and_cleanup_leave_other_sites_unchanged(self):
        module.update(self.site, self.incoming, 'production')
        module.update(self.site, self.incoming, 'preview', '12')
        module.update(self.site, self.incoming, 'preview', '13')
        (self.site / 'previews/pr-12/stale.js').write_text('stale')
        module.update(self.site, self.incoming, 'preview', '12')
        self.assertFalse((self.site / 'previews/pr-12/stale.js').exists())
        module.update(self.site, self.incoming, 'remove', '12')
        module.update(self.site, self.incoming, 'remove', '12')
        self.assertFalse((self.site / 'previews/pr-12').exists())
        self.assertTrue((self.site / 'previews/pr-13/index.html').exists())
        self.assertEqual((self.site / 'index.html').read_text(), 'new build')

    def test_untrusted_artifact_cannot_set_domain_or_replace_other_previews(self):
        for name in ['CNAME', '.git', 'previews']:
            with self.subTest(name=name):
                bad = self.incoming / name
                bad.write_text('bad')
                with self.assertRaises(ValueError):
                    module.update(self.site, self.incoming, 'preview', '12')
                self.assertFalse((self.site / 'previews/pr-12').exists())
                bad.unlink()

    def test_symlink_is_rejected(self):
        (self.incoming / 'static' / 'link').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):
            module.update(self.site, self.incoming, 'production')

    def test_invalid_number_and_incomplete_build_are_rejected(self):
        with self.assertRaises(ValueError):
            module.update(self.site, self.incoming, 'remove', '../../')
        (self.incoming / 'index.html').unlink()
        with self.assertRaises(ValueError):
            module.update(self.site, self.incoming, 'production')


if __name__ == '__main__':
    unittest.main()
