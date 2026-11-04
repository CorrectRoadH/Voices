FROM python:3.12-slim-bookworm
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
ADD https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx /app/model.onnx
RUN echo 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11  /app/model.onnx' | sha256sum -c - \
    && chmod 444 /app/model.onnx \
    && useradd --uid 10002 --no-create-home --shell /usr/sbin/nologin voiceprint
COPY server.py ./
ENV MODEL_PATH=/app/model.onnx LISTEN_HOST=0.0.0.0 PYTHONDONTWRITEBYTECODE=1
USER voiceprint
HEALTHCHECK --interval=30s --timeout=15s --start-period=30s CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8091/healthz', timeout=12).read()"]
CMD ["python", "server.py"]
