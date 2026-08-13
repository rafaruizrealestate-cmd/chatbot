FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY agent.py .

# Descarga los ficheros de modelo (VAD, turn detector) en build para arranque rápido.
RUN python agent.py download-files || true

CMD ["python", "agent.py", "start"]
