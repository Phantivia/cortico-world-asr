"""Local FireRedASR2-AED endpoint for the asr World PCM16 WAV client."""

import argparse
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import logging
from pathlib import Path
import sys
import threading
import wave

MODEL_NAME = 'FireRedASR2-AED'
MAX_BODY_BYTES = 4 * 1024 * 1024
MODEL_FILES = ('model.pth.tar', 'cmvn.ark', 'dict.txt', 'train_bpe1000.model')


def read_upload(content_type, body):
    message = BytesParser(policy=policy.default).parsebytes(
        f'Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n'.encode() + body)
    if message.get_content_type() != 'multipart/form-data' or not message.is_multipart():
        raise ValueError('Expected multipart/form-data')
    files = []
    response_format = 'json'
    for part in message.iter_parts():
        name = part.get_param('name', header='content-disposition')
        if name == 'file':
            files.append(part.get_payload(decode=True))
        elif name == 'response_format':
            response_format = part.get_payload(decode=True).decode('utf-8')
    if len(files) != 1 or not isinstance(files[0], bytes):
        raise ValueError('Exactly one file is required')
    if response_format not in ('json', 'text'):
        raise ValueError('response_format must be json or text')
    try:
        with wave.open(io.BytesIO(files[0]), 'rb') as audio:
            if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (16000, 1, 2):
                raise ValueError('Audio must be 16 kHz mono PCM16 WAV')
            frames = audio.getnframes()
            if not 400 <= frames <= 16000 * 60:
                raise ValueError('Audio duration must be between 25 ms and 60 s')
            pcm = audio.readframes(frames)
            if len(pcm) != frames * 2:
                raise ValueError('Truncated WAV audio')
    except (wave.Error, EOFError) as exc:
        raise ValueError('Invalid PCM WAV file') from exc
    return pcm, response_format


class AsrHttpServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, engine):
        self.engine = engine
        self.inference_lock = threading.Lock()
        super().__init__(address, AsrHandler)


class AsrHandler(BaseHTTPRequestHandler):
    def send_body(self, status, value, content_type='application/json; charset=utf-8'):
        body = (json.dumps(value, ensure_ascii=False) if content_type.startswith('application/json') else value).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # The caller can time out while GPU decoding is in progress.

    def do_GET(self):
        if self.path in ('/', '/health'):
            self.send_body(200, {'status': 'ok', 'model': MODEL_NAME})
        else:
            self.send_body(404, {'error': 'Not found'})

    def do_POST(self):
        if self.path != '/v1/audio/transcriptions':
            self.send_body(404, {'error': 'Not found'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BODY_BYTES:
                self.send_body(413, {'error': 'Missing or oversized request body'})
                return
            self.connection.settimeout(30)
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError('Truncated request body')
            pcm, response_format = read_upload(self.headers.get('Content-Type', ''), body)
        except (ValueError, TimeoutError) as exc:
            self.send_body(400, {'error': str(exc)})
            return
        try:
            with self.server.inference_lock:
                text = self.server.engine.transcribe(pcm)
            if response_format == 'text':
                self.send_body(200, text, 'text/plain; charset=utf-8')
            else:
                self.send_body(200, {'text': text})
        except Exception:
            logging.exception('FireRed transcription failed')
            self.send_body(500, {'error': 'FireRed transcription failed; see server log'})

    def log_message(self, fmt, *args):
        logging.info(fmt, *args)


class FireRedEngine:
    def __init__(self, source_dir, model_file, device, threads):
        for filename in MODEL_FILES:
            if not (model_file.parent / filename).is_file():
                raise FileNotFoundError(model_file.parent / filename)
        if model_file.name != 'model.pth.tar':
            raise ValueError('Select the FireRedASR2-AED model.pth.tar file')
        sys.path.insert(0, str(source_dir))
        import numpy as np
        import torch
        from fireredasr2s.fireredasr2 import FireRedAsr2, FireRedAsr2Config
        self.np = np
        torch.set_num_threads(threads or 4)
        torch.set_num_interop_threads(4)
        torch.manual_seed(0)
        if device == 'cuda' and not torch.cuda.is_available():
            raise RuntimeError('CUDA is unavailable; install the CUDA runtime or select the cpu profile')
        config = FireRedAsr2Config(use_gpu=device == 'cuda', use_half=False, beam_size=3,
            nbest=1, softmax_smoothing=1.25, aed_length_penalty=0.6,
            eos_penalty=1.0, return_timestamp=False)
        self.model = FireRedAsr2.from_pretrained('aed', str(model_file.parent), config)
        self.transcribe(bytes(16000))

    def transcribe(self, pcm):
        waveform = self.np.frombuffer(pcm, dtype='<i2')
        # FireRed's feature extractor expects samples in the PCM16 amplitude range.
        result = self.model.transcribe(['speech'], [(16000, waveform)])
        if not result:
            raise RuntimeError('FireRed returned no hypothesis')
        return result[0]['text']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8793)
    parser.add_argument('--model-file', type=Path, required=True)
    parser.add_argument('--source-dir', type=Path, required=True)
    parser.add_argument('--device', choices=('cuda', 'cpu'), default='cuda')
    parser.add_argument('--threads', type=int, default=4)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    engine = FireRedEngine(args.source_dir, args.model_file, args.device, args.threads)
    # Bind only after loading and warmup; a successful health request means ready to transcribe.
    with AsrHttpServer((args.host, args.port), engine) as server:
        logging.info('%s ready at http://%s:%s', MODEL_NAME, args.host, args.port)
        server.serve_forever()


if __name__ == '__main__':
    main()
