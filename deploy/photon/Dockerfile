# Self-hosted Photon geocoder (optional compose profile "photon"). Not built in CI.
FROM eclipse-temurin:21-jre
ARG PHOTON_VERSION=0.7.0
RUN apt-get update && apt-get install -y --no-install-recommends bzip2 curl && rm -rf /var/lib/apt/lists/*
ADD https://github.com/komoot/photon/releases/download/${PHOTON_VERSION}/photon-${PHOTON_VERSION}.jar /photon/photon.jar
COPY entrypoint.sh /photon/entrypoint.sh
RUN chmod +x /photon/entrypoint.sh
WORKDIR /photon/data
EXPOSE 2322
ENTRYPOINT ["/photon/entrypoint.sh"]
