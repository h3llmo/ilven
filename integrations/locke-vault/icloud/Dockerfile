# syntax=docker/dockerfile:1
# Locke-Vault iCloud sidecar (experimental). Build context: integrations/locke-vault/icloud
FROM python:3.13-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt

FROM base AS test
RUN pip install httpx==0.28.1
COPY app.py test_app.py ./
RUN python -m unittest -v test_app.py && touch /tested

FROM base
# Never write the Apple password anywhere: pyicloud's keyring lookups go to a null backend.
ENV PYTHON_KEYRING_BACKEND=keyring.backends.null.Keyring HOME=/tmp
COPY --from=test /tested /tested
COPY app.py ./
USER 1000:1000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--no-server-header"]
