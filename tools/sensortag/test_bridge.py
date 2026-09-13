"""Collector lifecycle regression with a fake BLE device; never touches the real radio."""
import asyncio
import importlib.util
from pathlib import Path
import struct
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location('collector', Path(__file__).with_name('bridge.py'))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class CollectorLifecycle(unittest.IsolatedAsyncioTestCase):
    async def test_reconnect_reuses_device_and_sequence_and_upload_recovers(self):
        loop = asyncio.get_running_loop()
        done = asyncio.Event()
        clients, writes, frames, events, scans = [], [], [], [], []
        uploads = 0
        device = SimpleNamespace(name='Test SensorTag')

        class Scanner:
            @staticmethod
            async def find_device_by_address(*args, **kwargs):
                scans.append(1)
                return device

        class Client:
            def __init__(self, found, disconnected_callback):
                self.callback = disconnected_callback
                self.is_connected = True
                self.services = self
                self.tasks = []
                clients.append(self)
                self.index = len(clients)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                self.is_connected = False
                for task in self.tasks:
                    task.cancel()
                await asyncio.gather(*self.tasks, return_exceptions=True)

            def get_characteristic(self, char):
                if char.startswith(('00002a19', '0000ffe1')):
                    return None
                return SimpleNamespace(uuid=char, properties=['notify', 'read'])

            async def read_gatt_char(self, char):
                if char == collector.ti('ccc1'):
                    return struct.pack('<HHH', 24, 0, 600)
                if char.startswith('00002a24'):
                    return b'CC2650 SensorTag'
                if char.startswith('00002a26'):
                    return b'1.20'
                if char == collector.ti('aa22'):
                    return b'\xff'
                return b'\x0a'

            async def write_gatt_char(self, char, value, **kwargs):
                writes.append((char, value))

            async def start_notify(self, char, callback):
                if char.uuid != collector.ti('aa81'):
                    return
                async def notify():
                    for i in range(100):
                        callback(None, struct.pack('<9h', 0,0,0,0,0,4096,0,0,0))
                        await asyncio.sleep(.005)
                        if self.index == 1 and i == 8:
                            self.is_connected = False
                            self.callback(self)
                            return
                self.tasks.append(asyncio.create_task(notify()))

        def post(url, body):
            nonlocal uploads
            uploads += 1
            if uploads == 1:
                raise HTTPError(url, 503, 'temporary', {}, None)
            frames.append(body)
            if len(clients) == 2 and len(frames) > 12:
                loop.call_soon_threadsafe(done.set)
            return 200

        args = SimpleNamespace(scan=False, device='test-tag', api='http://test', session='s', batch='b')
        with patch.dict(sys.modules, {'bleak': SimpleNamespace(BleakClient=Client, BleakScanner=Scanner)}), \
             patch.dict('os.environ', {'MUMAI_SENSOR_TOKEN':'test-only'}), \
             patch.object(collector, 'post', post), \
             patch.object(collector, 'emit', lambda state, message, **kw: events.append({'state':state, 'message':message, **kw})):
            task = asyncio.create_task(collector.run(args))
            try:
                await asyncio.wait_for(done.wait(), 3)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(len(scans), 1)
        self.assertEqual(len({f['streamId'] for f in frames}), 1)
        seqs = [f['seq'] for f in frames]
        self.assertEqual(seqs, sorted(set(seqs)))
        self.assertIn((collector.ti('ccc2'), struct.pack('<HHHH',24,24,0,600)), writes)
        self.assertIn((collector.ti('aa22'), b'\x00'), writes)
        self.assertIn((collector.ti('aa82'), b'\x3f\x02'), writes)
        self.assertTrue(any(e.get('uploadState')=='error' and e['state']=='online' for e in events))
        self.assertTrue(any(e.get('uploadState')=='online' for e in events))
        self.assertTrue(any(e.get('disconnectCount')==1 for e in events))


if __name__ == '__main__':
    unittest.main()
