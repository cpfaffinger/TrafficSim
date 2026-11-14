#!/bin/sh
# Downloads the Photon search index on first start, then serves it on port 2322.
set -eu
if [ ! -d /photon/data/photon_data ]; then
  echo "downloading Photon index from ${PHOTON_DATA_URL}"
  curl -fsSL "${PHOTON_DATA_URL}" | tar -xj -C /photon/data
fi
exec java -jar /photon/photon.jar -data-dir /photon/data -listen-ip 0.0.0.0
