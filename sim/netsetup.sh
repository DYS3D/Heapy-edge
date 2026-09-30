#!/bin/sh
# Test network for the HEAPY Edge simulator (Linux, root).
# br-bas (10.77.0.2/24) = the site box's BAS port; netns "bas-sim" holds the simulated devices.
set -e
N=${1:-40}
ip netns del bas-sim 2>/dev/null || true
ip link del br-bas 2>/dev/null || true
ip link add br-bas type bridge
ip addr add 10.77.0.2/24 brd 10.77.0.255 dev br-bas
ip link set br-bas up
ip netns add bas-sim
ip link add veth-bas type veth peer name veth-sim
ip link set veth-bas master br-bas
ip link set veth-bas up
ip link set veth-sim netns bas-sim
ip netns exec bas-sim ip link set lo up
ip netns exec bas-sim ip link set veth-sim up
i=0
while [ $i -lt $N ]; do
  ip netns exec bas-sim ip addr add 10.77.0.$((10+i))/24 brd 10.77.0.255 dev veth-sim
  i=$((i+1))
done
echo "br-bas up, bas-sim has 10.77.0.10-10.77.0.$((9+N))"
