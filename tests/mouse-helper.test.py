import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
sys.dont_write_bytecode = True
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mouse_buttons', Path(__file__).parents[1] / 'scripts/mouse-buttons.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class MouseHelperTests(unittest.TestCase):
    def run_monitor(self, packets, initial=False):
        emitted = []
        reads = iter(packets + [b''])
        ready = iter([([42], [], []) for _ in packets] + [([helper.sys.stdin], [], [])])
        with patch.object(helper, 'devices', return_value=[{'path': '/dev/input/event42'}]), \
             patch.object(helper.os, 'open', return_value=42) as opened, \
             patch.object(helper.os, 'fstat', return_value=type('Info', (), {'st_mode': stat.S_IFCHR})()), \
             patch.object(helper, 'held', return_value=initial), \
             patch.object(helper.os, 'close') as closed, \
             patch.object(helper.select, 'select', side_effect=lambda *args: next(ready)), \
             patch.object(helper.os, 'read', side_effect=lambda *args: next(reads)), \
             patch.object(helper, 'emit', side_effect=emitted.append), \
             patch.object(helper.time, 'time', return_value=100):
            try:
                helper.monitor('/dev/input/event42')
            finally:
                closed.assert_called_once_with(42)
            self.assertEqual(opened.call_args.args[1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        return emitted

    def test_only_left_button_is_forwarded_and_initial_hold_is_reported(self):
        packet = lambda kind, code, value: helper.EVENT.pack(100, 0, kind, code, value)
        result = self.run_monitor([packet(1, 30, 1) + packet(2, 0, 25) + packet(1, 272, 0), packet(1, 272, 1)], initial=True)
        self.assertEqual(result[0], {'ready': True, 'pressed': True})
        self.assertEqual(result[1], {'pressed': False})
        self.assertEqual(result[-1], {'pressed': True})
        self.assertTrue(all(set(item) <= {'ready', 'pressed'} for item in result))

    def test_lost_events_abort_instead_of_inventing_a_fire_edge(self):
        with self.assertRaisesRegex(RuntimeError, 'lost events'):
            self.run_monitor([helper.EVENT.pack(100, 0, 0, 3, 0)])

    def test_stale_events_abort(self):
        with self.assertRaisesRegex(RuntimeError, 'delayed'):
            self.run_monitor([helper.EVENT.pack(99, 0, 1, 272, 1)])

    def test_unknown_device_never_opens(self):
        with patch.object(helper, 'devices', return_value=[]), patch.object(helper.os, 'open') as opened:
            with self.assertRaisesRegex(ValueError, 'Select'):
                helper.monitor('/tmp/arbitrary')
            opened.assert_not_called()

    def test_sysfs_words_preserve_native_word_padding(self):
        from io import StringIO
        with patch('builtins.open', return_value=StringIO('1 0')):
            self.assertEqual(helper.bitmap('unused'), 1 << (helper.struct.calcsize('@L') * 8))


if __name__ == '__main__':
    unittest.main()
