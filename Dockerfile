# Mesmo major do host: node:sqlite ainda é experimental e sua API mudou entre
# majors — desenvolver no 22 e rodar no 24 pediria bug de divergência.
FROM node:22-alpine

# node:sqlite emite ExperimentalWarning a cada boot; o resto do log é útil.
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    NODE_ENV=production \
    ARTEFATOS_HOST=0.0.0.0 \
    ARTEFATOS_PORT=7788

WORKDIR /app

# Sem dependências para instalar: não há npm install, não há bundler.
# Os "assets" são servidos estáticos de public/ — o que a imagem entrega é a
# aplicação pronta para rodar, sem Node nem setup na máquina.
COPY package.json ./
COPY bin/ ./bin/
COPY src/ ./src/
COPY public/ ./public/

# O HOME precisa bater com o do host: os caminhos gravados nos transcripts são
# absolutos, e é por eles que o scanner acha os arquivos montados.
ARG HOST_HOME=/home/user
ENV HOME=${HOST_HOME}

EXPOSE 7788

HEALTHCHECK --interval=60s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ARTEFATOS_PORT||7788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bin/artefatos.js", "--no-open"]
