# HEAPY Edge site box image (64-bit ARM and x86).
# Run with host networking so BACnet broadcasts reach the BAS network:
#   docker run -d --name heapy-edge --network host --restart unless-stopped -v heapy-edge-data:/data heapy-edge
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/heapy-edge
COPY drivers/bacnet-ip/requirements.txt drivers/bacnet-ip/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r drivers/bacnet-ip/requirements.txt
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
