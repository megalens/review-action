# Hardened GitLab Runner Docker helper image (optional, for self-managed Docker/Kubernetes
# runners that cannot set ci_pipeline_variables_minimum_override_role = "no_one_allowed"
# and reuse build volumes across jobs).
#
# GitLab Runner's Docker executor runs Pre-job (get_sources, restore_cache, download_artifacts)
# and Post-job (upload_artifacts, archive_cache) in a separate helper container, NOT in the
# job's `image:` container. Locking PATH, BASH_ENV, ENV, and LD_PRELOAD readonly inside the
# helper container prevents a manual-job or pipeline PATH/BASH_ENV override from running an
# MR-supplied executable during writeExports, SourceEnv (mkdir/touch), or artifacts-uploader.
#
# Build with a digest-pinned official Ubuntu-flavor GitLab Runner helper base image matching
# your GitLab Runner version (Ubuntu flavor ships /bin/bash so GitLab Runner's shell detector
# execs /usr/local/bin/bash first):
#   docker build -f docker/gitlab-runner-helper.Dockerfile \
#     --build-arg HELPER_BASE_IMAGE=registry.gitlab.com/gitlab-org/gitlab-runner/gitlab-runner-helper@sha256:<DIGEST> \
#     -t registry.example.com/megalens/gitlab-runner-helper:v18.5.0 .
#   docker push registry.example.com/megalens/gitlab-runner-helper:v18.5.0
# Then pin its resulting @sha256 digest in runner config.toml:
#   [runners.docker]
#     helper_image = "registry.example.com/megalens/gitlab-runner-helper@sha256:<BUILT_DIGEST>"

ARG HELPER_BASE_IMAGE
FROM ${HELPER_BASE_IMAGE}

ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    BASH_ENV="/usr/local/lib/megalens-bash-env.sh"

RUN test -x /bin/bash \
  && mkdir -p /usr/local/lib /usr/local/bin /etc/profile.d \
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
  && chmod 0755 /usr/local/bin/bash
