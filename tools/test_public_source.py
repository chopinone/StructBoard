"""Privacy boundaries use synthetic canaries only."""
from pathlib import Path
import importlib.util, json, tempfile, unittest

spec=importlib.util.spec_from_file_location('guard',Path(__file__).with_name('check_public_source.py'))
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)

class PublicBoundary(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        (self.root/'app.py').write_text('print("synthetic fixture")\n')
        (self.root/'public-source.json').write_text(json.dumps({'version':1,'files':['app.py'],'reviewedAssets':{}}))
    def test_explicit_inventory_passes(self):
        self.assertEqual(guard.audit(self.root,True),[])
    def test_extra_pipeline_is_rejected(self):
        (self.root/'private-pipeline.json').write_text('{}')
        self.assertTrue(any('unexpected public file' in x for x in guard.audit(self.root,True)))
    def test_credential_in_allowed_code_is_rejected_without_echoing_it(self):
        value='sk-'+'x'*36
        (self.root/'app.py').write_text('api_key = '+repr(value))
        results=guard.audit(self.root,True)
        self.assertTrue(results);self.assertNotIn(value,str(results))
    def test_metadata_image_requires_review(self):
        (self.root/'public-source.json').write_text(json.dumps({'version':1,'files':['app.py','photo.png'],'reviewedAssets':{}}))
        (self.root/'photo.png').write_bytes(b'\x89PNG\0synthetic')
        self.assertTrue(any('not been reviewed' in x for x in guard.audit(self.root,True)))
    def test_parent_escape_is_rejected(self):
        (self.root/'public-source.json').write_text(json.dumps({'version':1,'files':['../outside.txt'],'reviewedAssets':{}}))
        with self.assertRaises(ValueError):guard.audit(self.root,True)

if __name__=='__main__':unittest.main(verbosity=2)
