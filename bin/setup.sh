#!/usr/bin/env bash
#
# Detecta o ambiente do Claude Code nesta máquina e prepara o container:
# escreve .env e compose.override.yaml com as montagens que existem aqui.
#
# Nada é adivinhado — cada caminho é verificado antes de entrar no arquivo, e
# os diretórios graváveis são criados com o seu usuário para o Docker não os
# criar como root.
#
#   ./bin/setup.sh              detecta, escreve e mostra o resumo
#   ./bin/setup.sh --dry-run    só mostra o que faria
#   ./bin/setup.sh --port 8080  fixa a porta (padrão: mantém a atual ou 7788)

set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

DRY_RUN=0
PORTA_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --port) PORTA_ARG="${2:-}"; shift ;;
    -h|--help)
      sed -n '3,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "opção desconhecida: $1" >&2; exit 1 ;;
  esac
  shift
done

if [ -t 1 ]; then
  N=$'\033[0m'; B=$'\033[1m'; D=$'\033[2m'
  VERDE=$'\033[32m'; AMARELO=$'\033[33m'; VERMELHO=$'\033[31m'
else
  N=""; B=""; D=""; VERDE=""; AMARELO=""; VERMELHO=""
fi

ok()    { printf '    %s✓%s %s\n' "$VERDE" "$N" "$*"; }
plural(){ [ "$1" = 1 ] && printf '1 %s' "$2" || printf '%s %ss' "$1" "$2"; }
pulou() { printf '    %s✗%s %s%s%s\n' "$VERMELHO" "$N" "$D" "$*" "$N"; }
info()  { printf '    %s\n' "$*"; }
titulo(){ printf '\n  %s%s%s\n' "$B" "$*" "$N"; }

# ------------------------------------------------------------------ ambiente

titulo "Detectando ambiente"

HOST_HOME="$HOME"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
TMP_BASE="${TMPDIR:-/tmp}"
TMP_BASE="${TMP_BASE%/}"
HOST_SCRATCH="$TMP_BASE/claude-$HOST_UID"

printf '    %-18s %s\n' "HOME" "$HOST_HOME"
printf '    %-18s %s\n' "uid:gid" "$HOST_UID:$HOST_GID"
printf '    %-18s %s\n' "tmpdir" "$TMP_BASE"

if [ -d "$HOST_SCRATCH" ]; then
  n_scratch="$(find "$HOST_SCRATCH" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  printf '    %-18s %s  %s(%s)%s\n' "scratchpad" "$HOST_SCRATCH" "$D" "$(plural "$n_scratch" projeto)" "$N"
else
  # O compose monta este caminho; se ele não existir na hora do `up`, o Docker
  # o cria como root e o container (uid do host) não consegue mais lê-lo.
  printf '    %-18s %s  %s(vazio — criado agora)%s\n' "scratchpad" "$HOST_SCRATCH" "$AMARELO" "$N"
  [ "$DRY_RUN" = 1 ] || mkdir -p "$HOST_SCRATCH"
fi

if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  printf '    %-18s %s\n' "CLAUDE_CONFIG_DIR" "$CLAUDE_CONFIG_DIR"
else
  printf '    %-18s %s(não definido — instalação padrão)%s\n' "CLAUDE_CONFIG_DIR" "$D" "$N"
fi

# ------------------------------------------------- raízes de transcript

titulo "Raízes de transcript"

RAIZES=()

# Registra <dir>/projects se existir e ainda não tiver entrado.
considerar() {
  local base="$1" projects
  [ -n "$base" ] || return 0
  projects="$base/projects"
  [ -d "$projects" ] || return 0
  projects="$(cd "$projects" && pwd -P)"
  local j
  for j in ${RAIZES[@]+"${RAIZES[@]}"}; do
    [ "$j" = "$projects" ] && return 0
  done
  RAIZES+=("$projects")
}

# Mesma ordem de precedência do scanner (src/config.js).
considerar "${CLAUDE_CONFIG_DIR:-}"

if [ -n "${ARTEFATOS_CONFIG_DIRS:-}" ]; then
  IFS=',' read -ra EXTRAS <<< "$ARTEFATOS_CONFIG_DIRS"
  for e in "${EXTRAS[@]}"; do
    considerar "$(echo "$e" | xargs)"
  done
fi

considerar "$HOST_HOME/.claude"

IGNORADOS=()

if [ -d "$HOST_HOME/.claude-profiles" ]; then
  for perfil in "$HOST_HOME/.claude-profiles"/*/; do
    [ -d "$perfil" ] || continue
    if [ -d "$perfil/projects" ]; then
      considerar "${perfil%/}"
    else
      IGNORADOS+=("${perfil%/}")
    fi
  done
fi

if [ ${#RAIZES[@]} -eq 0 ]; then
  printf '\n  %sNenhuma raiz de transcript encontrada.%s\n' "$VERMELHO" "$N"
  printf '  O Claude Code guarda os transcripts em ~/.claude/projects ou em\n'
  printf '  $CLAUDE_CONFIG_DIR/projects. Aponte a sua com:\n\n'
  printf '    CLAUDE_CONFIG_DIR=/caminho ./bin/setup.sh\n'
  printf '    ARTEFATOS_CONFIG_DIRS=/dir1,/dir2 ./bin/setup.sh\n\n'
  exit 1
fi

for r in "${RAIZES[@]}"; do
  n="$(find "$r" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  ok "$(printf '%-42s (%s)' "$(printf '%s' "$r" | sed "s|^$HOST_HOME|~|")" "$(plural "$n" projeto)")"
done

for i in ${IGNORADOS[@]+"${IGNORADOS[@]}"}; do
  pulou "$(printf '%-42s (sem projects/)' "$(printf '%s' "$i" | sed "s|^$HOST_HOME|~|")")"
done

# --------------------------------------- outros caminhos que valem montar

titulo "Outras origens"

EXTRAS_RO=()
adicionar_ro() {
  if [ -d "$1" ]; then
    EXTRAS_RO+=("$1")
    ok "$(printf '%s' "$1" | sed "s|^$HOST_HOME|~|")"
  else
    pulou "$(printf '%s' "$1" | sed "s|^$HOST_HOME|~|")  (não existe)"
  fi
}

# Artefatos publicados de dentro de jobs em segundo plano.
adicionar_ro "$HOST_HOME/.claude/jobs"
# Artefatos publicados de dentro do próprio repositório (docs/, project-docs/).
adicionar_ro "$HOST_HOME/projects"

# ------------------------------------------------------ diretórios graváveis

titulo "Diretórios graváveis"

DB_DIR="${XDG_DATA_HOME:-$HOST_HOME/.local/share}/artefatos"
SAVE_DIR="${ARTEFATOS_SAVE_DIR:-$HOST_HOME/artefatos-salvos}"

for d in "$DB_DIR" "$SAVE_DIR"; do
  if [ -d "$d" ]; then
    ok "$(printf '%s' "$d" | sed "s|^$HOST_HOME|~|")  (já existe)"
  elif [ "$DRY_RUN" = 1 ]; then
    info "criaria $d"
  else
    mkdir -p "$d"
    ok "$(printf '%s' "$d" | sed "s|^$HOST_HOME|~|")  (criado)"
  fi
done
info "${D}criados agora para o Docker não criá-los como root${N}"

# ------------------------------------------------------------ preferências

# Mantém o que já estava configurado; só preenche o que falta.
valor_atual() {
  [ -f .env ] && grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true
}

PORTA="${PORTA_ARG:-$(valor_atual ARTEFATOS_PORT)}"
PORTA="${PORTA:-7788}"
INTERVALO="$(valor_atual ARTEFATOS_ARCHIVE_INTERVAL)"
INTERVALO="${INTERVALO:-300000}"

TZ_DETECTADA="$(valor_atual TZ)"
if [ -z "$TZ_DETECTADA" ]; then
  if [ -r /etc/timezone ]; then
    TZ_DETECTADA="$(cat /etc/timezone)"
  elif command -v timedatectl >/dev/null 2>&1; then
    TZ_DETECTADA="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  fi
fi
TZ_DETECTADA="${TZ_DETECTADA:-UTC}"

# -------------------------------------------------------------- gravação

ENV_CONTEUDO="# Gerado por bin/setup.sh — ajuste à vontade, o script preserva
# ARTEFATOS_PORT, ARTEFATOS_ARCHIVE_INTERVAL e TZ nas próximas execuções.
HOST_HOME=$HOST_HOME
HOST_UID=$HOST_UID
HOST_GID=$HOST_GID
HOST_SCRATCH=$HOST_SCRATCH
ARTEFATOS_PORT=$PORTA
ARTEFATOS_ARCHIVE_INTERVAL=$INTERVALO
TZ=$TZ_DETECTADA
"

OVERRIDE_CONTEUDO="# GERADO POR bin/setup.sh — reexecute o script em vez de editar à mão.
#
# Cada caminho aparece igual dos dois lados: os transcripts guardam caminhos
# absolutos, e é por eles que o scanner encontra os arquivos. Montar em outro
# lugar faria todo artefato parecer removido.
#
# Só as pastas projects/ entram — nunca a raiz de um perfil, que guarda
# .credentials.json.

services:
  artefatos:
    volumes:"

for r in "${RAIZES[@]}"; do
  OVERRIDE_CONTEUDO="$OVERRIDE_CONTEUDO
      - $r:$r:ro"
done

for e in ${EXTRAS_RO[@]+"${EXTRAS_RO[@]}"}; do
  OVERRIDE_CONTEUDO="$OVERRIDE_CONTEUDO
      - $e:$e:ro"
done

N_MOUNTS=$(( ${#RAIZES[@]} + ${#EXTRAS_RO[@]} ))

titulo "Arquivos"

if [ "$DRY_RUN" = 1 ]; then
  info "${D}--dry-run: nada foi escrito${N}"
  printf '\n%s\n' "--- .env ---"
  printf '%s' "$ENV_CONTEUDO"
  printf '\n%s\n' "--- compose.override.yaml ---"
  printf '%s\n' "$OVERRIDE_CONTEUDO"
  exit 0
fi

for arquivo in .env compose.override.yaml; do
  if [ -f "$arquivo" ]; then
    cp "$arquivo" "$arquivo.bak"
    info "${D}backup: $arquivo.bak${N}"
  fi
done

printf '%s' "$ENV_CONTEUDO" > .env
printf '%s\n' "$OVERRIDE_CONTEUDO" > compose.override.yaml

ok ".env"
ok "compose.override.yaml  ($(plural "$N_MOUNTS" montagem | sed 's/montagems/montagens/'))"

# ------------------------------------------------------- slash command

titulo "Slash command /artefatos"

TEMPLATE="$RAIZ/commands/artefatos.md"

if [ ! -f "$TEMPLATE" ]; then
  pulou "commands/artefatos.md não encontrado — pulei"
else
  # Instalado em cada config do Claude Code que existe aqui. É cópia com o
  # caminho e a porta embutidos, não symlink: o comando precisa saber onde a
  # ferramenta mora, e isso varia por máquina. Reexecute o setup para atualizar.
  N_CMD=0
  for r in "${RAIZES[@]}"; do
    config_dir="$(dirname "$r")"
    destino="$config_dir/commands/artefatos.md"
    [ "$DRY_RUN" = 1 ] || mkdir -p "$config_dir/commands"
    if [ "$DRY_RUN" = 1 ]; then
      info "instalaria em $(printf '%s' "$destino" | sed "s|^$HOST_HOME|~|")"
    else
      sed -e "s|{{ARTEFATOS_DIR}}|$RAIZ|g" -e "s|{{ARTEFATOS_PORT}}|$PORTA|g" \
        "$TEMPLATE" > "$destino"
      ok "$(printf '%s' "$destino" | sed "s|^$HOST_HOME|~|")"
    fi
    N_CMD=$((N_CMD + 1))
  done
  info "${D}use /artefatos em qualquer sessão dos $N_CMD perfis${N}"
fi

# ------------------------------------------------------------ pré-requisitos

titulo "Pré-requisitos"

FALTA_DOCKER=0
if command -v docker >/dev/null 2>&1; then
  ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"
  if docker compose version >/dev/null 2>&1; then
    ok "docker compose $(docker compose version --short 2>/dev/null || echo '')"
  else
    pulou "docker compose (plugin v2 ausente)"
    FALTA_DOCKER=1
  fi
else
  pulou "docker (não instalado)"
  FALTA_DOCKER=1
fi

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 22 ]; then
    ok "node $(node -v)  ${D}(CLI local disponível)${N}"
  else
    pulou "node $(node -v) — o CLI local precisa de 22+ (node:sqlite)"
  fi
else
  pulou "node ausente — sem CLI local; o container não depende disso"
fi

# ------------------------------------------------------------------ final

printf '\n  %sPronto.%s\n\n' "$B" "$N"
if [ "$FALTA_DOCKER" = 0 ]; then
  printf '    docker compose up -d --build      %s# sobe em http://127.0.0.1:%s%s\n' "$D" "$PORTA" "$N"
else
  printf '    node bin/artefatos.js             %s# sem docker, direto pelo Node%s\n' "$D" "$N"
fi
printf '\n'
