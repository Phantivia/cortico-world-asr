import array
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import http.client
import importlib.util
import io
import json
from pathlib import Path
import threading
import time
import unittest
import wave

spec = importlib.util.spec_from_file_location('firered_server', Path(__file__).parents[2] / 'src/firered-server.py')
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)


def wav_bytes(rate=16000):
    out = io.BytesIO()
    with wave.open(out, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(array.array('h', [100, -50] * 400).tobytes())
    return out.getvalue()


def multipart(audio, response_format='json'):
    return (b'--test\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\n'
            b'Content-Type: audio/wav\r\n\r\n' + audio + b'\r\n--test\r\n'
            b'Content-Disposition: form-data; name="response_format"\r\n\r\n' + response_format.encode() + b'\r\n--test--\r\n')


class PcmEngine:
    """Computes from decoded samples so HTTP tests detect audio corruption."""
    def __init__(self):
        self.active = 0
        self.max_active = 0

    def transcribe(self, pcm):
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            time.sleep(.08)
            samples = array.array('h')
            samples.frombytes(pcm)
            return f'{len(samples)}:{sum(samples)}'
        finally:
            self.active -= 1


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.engine = PcmEngine()
        self.server = server_module.AsrHttpServer(('127.0.0.1', 0), self.engine)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, body=None, method='POST', path='/v1/audio/transcriptions', content_type='multipart/form-data; boundary=test'):
        with closing(http.client.HTTPConnection(*self.server.server_address, timeout=3)) as conn:
            conn.request(method, path, body=body, headers={'Content-Type': content_type})
            response = conn.getresponse()
            return response.status, response.read().decode()

    def test_round_trip_preserves_pcm_and_supports_json_and_text(self):
        status, body = self.request(multipart(wav_bytes()))
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'text': '800:20000'})
        self.assertEqual(self.request(multipart(wav_bytes(), 'text')), (200, '800:20000'))

    def test_invalid_audio_and_formats_are_rejected_before_inference(self):
        for body in (multipart(wav_bytes(8000)), multipart(b'broken'), multipart(wav_bytes()[:-2]), multipart(wav_bytes(), 'srt')):
            self.assertEqual(self.request(body)[0], 400)
        self.assertEqual(self.request(b'bad', content_type='application/json')[0], 400)
        self.assertEqual(self.engine.max_active, 0)

    def test_concurrent_uploads_serialize_inference_and_health_stays_available(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = [pool.submit(self.request, multipart(wav_bytes())) for _ in range(2)]
            status, body = self.request(method='GET', path='/health')
            self.assertEqual((status, json.loads(body)['model']), (200, 'FireRedASR2-AED'))
            self.assertTrue(all(job.result()[0] == 200 for job in pending))
        self.assertEqual(self.engine.max_active, 1)


if __name__ == '__main__':
    unittest.main()
