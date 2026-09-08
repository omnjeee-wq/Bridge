# Third-party notices

Murph Stream Bridge can optionally build and run an isolated JVM worker based
on the upstream CNCVerse Bridge / CloudStream runtime.

The JVM worker is not granted additional rights by this project license. The
Docker build and `scripts/run-jvm-worker.sh` retrieve the upstream runtime from
its configured source repository at build time. Review that repository's
license, notices, and redistribution terms before distributing a Docker image
that contains the worker or enabling third-party `.cs3` plugins.

Remote Stremio manifests, CloudStream repositories, plugins, media providers,
logos, and other downloaded assets remain subject to their own licenses and
terms. Only connect and redistribute sources you are authorized to use.

Murph's original source code is licensed under the MIT License in `LICENSE`.