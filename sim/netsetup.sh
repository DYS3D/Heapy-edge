#!/bin/sh
# Test network for the HEAPY Edge simulators (Linux, root).
#   netsetup.sh [count] [name] [prefix]
# Bridge br-<name> (<prefix>.2/24) is the site box's BAS port; network namespace
# <name> holds the simulated devices at <prefix>.10 upward. Several labs can run
# side by side with different names and prefixes.
set -e
N=${1:-40}
NAME=${2:-bas-sim}
PFX=${3:-10.77.0}
BR=br-${NAME#bas-}
[ "$NAME" = "bas-sim" ] && BR=br-bas
VH=vh-${NAME#bas-}; VS=vs-${NAME#bas-}
[ "$NAME" = "bas-sim" ] && VH=veth-bas && VS=veth-sim
ip netns del "$NAME" 2>/dev/null || true
ip link del "$BR" 2>/dev/null || true
ip link del "$VH" 2>/dev/null || true
ip link add "$BR" type bridge
ip addr add "$PFX.2/24" brd "$PFX.255" dev "$BR"
ip link set "$BR" up
ip netns add "$NAME"
ip link add "$VH" type veth peer name "$VS"
ip link set "$VH" master "$BR"
ip link set "$VH" up
ip link set "$VS" netns "$NAME"
ip netns exec "$NAME" ip link set lo up
ip netns exec "$NAME" ip link set "$VS" up
i=0
while [ $i -lt $N ]; do
  ip netns exec "$NAME" ip addr add "$PFX.$((10+i))/24" brd "$PFX.255" dev "$VS"
  i=$((i+1))
done
echo "$BR up, $NAME has $PFX.10-$PFX.$((9+N))"
