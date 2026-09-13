ARG DOCKER_REGISTRY_PREFIX=

FROM ${DOCKER_REGISTRY_PREFIX:-}python:3.12-alpine

ARG APK_MIRROR

RUN if [ -n "$APK_MIRROR" ]; then sed -i "s|https://dl-cdn.alpinelinux.org/alpine|$APK_MIRROR|g" /etc/apk/repositories; fi \
 && apk add --no-cache docker-cli util-linux iproute2 bash

COPY scripts/presence.sh /usr/local/bin/presence.sh
RUN chmod +x /usr/local/bin/presence.sh

ENTRYPOINT ["/bin/sh", "-c", "while true; do presence.sh; sleep 15; done"]