import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import demo_data
import pipeline_api


class DemoTests(unittest.TestCase):
    def test_new_user_gets_complete_synthetic_pipeline_in_arbitrary_path(self):
        with tempfile.TemporaryDirectory(prefix='structboard-demo-') as directory:
            base = Path(directory) / '新用户 with spaces'
            pipes = base / 'pipelines'
            demo = demo_data.ensure_demo(base, pipes)
            with patch.object(pipeline_api, 'PIPE_DIR', str(pipes)):
                definition = pipeline_api.load_definition(demo_data.DEMO_ID)
                ok, errors, _ = pipeline_api.validate_definition(definition)
                self.assertTrue(ok, errors)
                counts = [len(pipeline_api.step_structures(demo_data.DEMO_ID, step['id'])['files']) for step in definition['steps']]
                self.assertEqual(counts, [1, 6, 18, 6])
                text = '\n'.join(p.read_text(encoding='utf-8') for p in demo.rglob('*') if p.is_file())
                # Verify fixture coordinates independently of any developer project.
                for coordinate in demo.rglob('*.pdb'):
                    self.assertIn('SYNTHETIC STRUCTBOARD DEMONSTRATION', coordinate.read_text())
                self.assertTrue(definition['demo'])
                self.assertEqual(Path(definition['root']).resolve(), demo.resolve())
                self.assertEqual(len(list(demo.rglob('*.pdb'))), 31)
                coordinates = (demo / 'template/synthetic_template.pdb').read_text()
                atoms = [line for line in coordinates.splitlines() if line.startswith('ATOM')]
                self.assertEqual(len(atoms), 330)
                self.assertEqual({line[21] for line in atoms}, {'A', 'B'})
                self.assertIn('ARTIFICIAL', coordinates)
            # Re-running/upgrading never overwrites demo notes or user pipelines.
            target = pipes / (demo_data.DEMO_ID + '.json')
            original = target.read_bytes()
            definition['name'] = 'My edited demonstration'
            target.write_text(json.dumps(definition), encoding='utf-8')
            demo_data.ensure_demo(base, pipes)
            self.assertEqual(json.loads(target.read_text())['name'], 'My edited demonstration')

    def test_published_selection_matches_demo_rule(self):
        rows = demo_data.score_rows()
        passed = {c for c in range(1, 7) if sum(row['demo_score'] >= .78 for row in rows
                  if row['design'].startswith(f'Aurora_{c:03d}_')) >= 2}
        self.assertEqual(passed, {1, 2})
        self.assertEqual(demo_data.pdb(1, 0), demo_data.pdb(1, 0))
        self.assertNotEqual(demo_data.pdb(1, 0), demo_data.pdb(1, 1))


if __name__ == '__main__':
    unittest.main(verbosity=2)
