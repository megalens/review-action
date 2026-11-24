# Pre-baked MegaLens GitLab CI runner image.
# Bakes git, ca-certificates, and bubblewrap (bwrap) into the image at build time so the
# pinned @sha256 image digest in templates/megalens-review.yml pins the exact sandbox binaries
# executed at runtime (zero runtime apt-get installs), locks PATH read-only before GitLab Runner's
# variable exports and SourceEnv (mkdir/touch) run, and executes as the unprivileged "node" user.
#
# Build & pin example:
#   docker build -f docker/gitlab-runner.Dockerfile -t registry.example.com/megalens/gitlab-runner:preview .
#   docker push registry.example.com/megalens/gitlab-runner:preview
#   # Copy the resulting immutable @sha256:... digest into the `image:` input in .gitlab-ci.yml.

FROM node:24-bookworm-slim@sha256:32e57b5784e8875d2cc0112dcaf13f9100f2d0d9446187808738e99aee29a5a2

ENV DEBIAN_FRONTEND=noninteractive \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    BASH_ENV="/usr/local/lib/megalens-bash-env.sh"

RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends \
    git \
    ca-certificates \
    bubblewrap \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /usr/local/lib /etc/profile.d \
  && printf '%s\n' \
    'PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' \
    'export PATH' \
    'readonly PATH' \
    'unset BASH_ENV ENV LD_PRELOAD' \
    'readonly BASH_ENV ENV LD_PRELOAD' \
    > /usr/local/lib/megalens-bash-env.sh \
  && chmod 0644 /usr/local/lib/megalens-bash-env.sh \
  && cp /usr/local/lib/megalens-bash-env.sh /etc/profile.d/zz-megalens-lock-path.sh \
  && chmod 0644 /etc/profile.d/zz-megalens-lock-path.sh \
  && printf '%s\n' \
    '#!/bin/sh' \
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' \
    'export BASH_ENV="/usr/local/lib/megalens-bash-env.sh"' \
    'unset ENV LD_PRELOAD NODE_OPTIONS NODE_DEBUG NODE_DEBUG_NATIVE' \
    'exec /bin/bash "$@"' \
    > /usr/local/bin/bash \
  && chmod 0755 /usr/local/bin/bash \
  && printf '%s\n' \
    '#!/bin/sh' \
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' \
    'export BASH_ENV="/usr/local/lib/megalens-bash-env.sh"' \
    'unset ENV LD_PRELOAD NODE_OPTIONS NODE_DEBUG NODE_DEBUG_NATIVE' \
    'exec "$@"' \
    > /usr/local/bin/megalens-entrypoint \
  && chmod 0755 /usr/local/bin/megalens-entrypoint \
  && git --version \
  && bwrap --version

ENTRYPOINT ["/usr/local/bin/megalens-entrypoint"]
USER node
