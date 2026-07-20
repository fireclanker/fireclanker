FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN dnf install -y nodejs npm \
 && npm install --prefix /opt/opencode --force --os=linux --cpu=arm64 --libc=glibc --omit=dev --ignore-scripts opencode-linux-arm64@1.18.3 \
 && chmod 0755 /opt/opencode/node_modules/opencode-linux-arm64/bin/opencode \
 && ln -s /opt/opencode/node_modules/opencode-linux-arm64/bin/opencode /usr/local/bin/opencode \
 && dnf clean all

ENV OPENCODE_DISABLE_PROJECT_CONFIG=1 \
    OPENCODE_PURE=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_AUTOCOMPACT=1 \
    OPENCODE_DISABLE_MODELS_FETCH=1 \
    OPENCODE_AUTH_CONTENT={}
