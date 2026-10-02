# Minimal `age`-image for verter uten age (NAS). Bygges lokalt av ops/backup/age-docker.sh.
FROM alpine:3.20
RUN apk add --no-cache age
ENTRYPOINT ["age"]
