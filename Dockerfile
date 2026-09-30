# HEAPY Edge site box image (64-bit ARM and x86).
# Run with host networking so BACnet broadcasts reach the BAS network:
#   docker run -d --name heapy-edge --network host --restart unless-stopped -v heapy-edge-data:/data heapy-edge
# MS/TP (RS-485 adapter) also needs: --cap-add NET_ADMIN --cap-add SYS_ADMIN --device /dev/ttyUSB0

# bacnet-stack's MS/TP router, built from a pinned release (used as a separate program)
FROM debian:bookworm-slim AS mstp
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY tools/build-bacnet-stack.sh tools/build-bacnet-stack.sh
RUN sh tools/build-bacnet-stack.sh

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip tini iproute2 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/heapy-edge
COPY drivers/bacnet-ip/requirements.txt drivers/bacnet-ip/requirements.txt
COPY drivers/snmp/requirements.txt drivers/snmp/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r drivers/bacnet-ip/requirements.txt -r drivers/snmp/requirements.txt
COPY --from=mstp /src/bin/router-mstp bin/router-mstp
COPY package.json ./
COPY core core
COPY drivers drivers
COPY web web
COPY contracts contracts
ENV HEAPY_EDGE_DATA=/data HEAPY_EDGE_HARDWARE=docker NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 8770
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:8770/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "core/main.js"]
