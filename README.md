# artefatos — catálogo dos artefatos do Claude Code

Lista todos os artefatos gerados pelo Claude Code, **agrupados por projeto** e
**ordenados por data de criação**. Você escolhe o projeto na lateral e recebe a
linha do tempo daquele projeto, com preview embutido, link do `claude.ai` e
cópia durável em um clique.

Um banco SQLite arquiva o **conteúdo** de cada artefato, então o catálogo
sobrevive à limpeza do `/tmp`. Sobe em Docker e fica sempre no ar.

Sem dependências — Node 22 (usa `node:sqlite` nativo) e nada mais.

---

## Subir

### Docker (recomendado)

```bash
./bin/setup.sh                # detecta o ambiente e escreve .env + override
docker compose up -d --build  # http://127.0.0.1:7788
docker compose logs -f
docker compose down
```

O `setup.sh` é o que torna a instalação portátil: descobre `HOME`, uid, `tmpdir`,
`CLAUDE_CONFIG_DIR` e quais perfis realmente têm `projects/`, cria os diretórios
graváveis com o seu usuário (senão o Docker os cria como root) e escreve
`compose.override.yaml` com as montagens que existem **nesta** máquina. Rode-o
de novo sempre que criar um perfil novo. `--dry-run` mostra sem escrever;
`--port N` fixa a porta. Os valores de porta, intervalo e TZ são preservados
entre execuções, e os arquivos anteriores viram `.bak`.

O `compose.yaml` base carrega só o que existe em qualquer instalação
(scratchpad, `~/.claude/projects` e os diretórios graváveis) — o resto vem do
override.

O código é copiado para dentro da imagem, então **depois de editar qualquer
arquivo de `src/`, `bin/` ou `public/`, use `docker compose up -d --build`** —
um `restart` sozinho continua servindo a versão antiga. Se for mexer bastante,
descomente o bind mount de desenvolvimento no fim do `compose.yaml`.

`restart: unless-stopped` traz o serviço de volta a cada boot, e o arquivador
roda a cada 5 minutos mesmo sem navegador aberto.

O `.env` que o setup escreve — dá para editar à mão, o script preserva porta,
intervalo e TZ nas próximas execuções:

```
HOST_HOME=/home/nandodev
HOST_UID=1000
HOST_GID=1000
HOST_SCRATCH=/tmp/claude-1000
ARTEFATOS_PORT=7788
ARTEFATOS_ARCHIVE_INTERVAL=300000
TZ=America/Sao_Paulo
```

`.env` e `compose.override.yaml` são específicos da máquina e ficam fora do
versionamento — em outro host, é só rodar o `setup.sh` de novo.

### Direto pelo Node

```bash
node bin/artefatos.js            # sobe e abre o navegador
node bin/artefatos.js --port 8080
node bin/artefatos.js --no-open
node bin/artefatos.js aqui       # só o projeto do diretório atual
node bin/artefatos.js list       # lista no terminal
node bin/artefatos.js list events
node bin/artefatos.js list --limit 20 --plain
node bin/artefatos.js scan       # relê tudo, arquiva, mostra estatísticas
node bin/artefatos.js stats      # o que há no banco
node bin/artefatos.js prune --days 30
```

O CLI e o container abrem **o mesmo banco** (é um caminho do host, não um
volume nomeado; SQLite em modo WAL cuida da concorrência). Rodar
`artefatos list` no host com o container no ar funciona normalmente.

Para chamar de qualquer lugar:

```bash
cd ~/projects/artefacts && npm link
# ou
echo "alias artefatos='node ~/projects/artefacts/bin/artefatos.js'" >> ~/.zshrc
```

### Slash command `/artefatos`

O `setup.sh` instala `/artefatos` em toda config do Claude Code que encontrar
(`~/.claude/commands/` e cada perfil), com o caminho da ferramenta e a porta já
embutidos — por isso é cópia, não symlink. Rode o setup de novo para atualizar.

| Uso | O que faz |
|---|---|
| `/artefatos` | artefatos do projeto onde a sessão está, mais recentes primeiro |
| `/artefatos todos` | todos os projetos |
| `/artefatos <termo>` | busca por nome de projeto |
| `/artefatos status` | o que há no banco |
| `/artefatos abrir` | sobe o container se preciso e abre o navegador |

Lê direto do SQLite, então funciona com o container parado.

### Na interface

| Ação | Como |
|---|---|
| Trocar de projeto | clique na lateral (a escolha fica salva) |
| Buscar | `/` foca o campo; filtra título, descrição, arquivo e projeto |
| Pré-visualizar | clique no cartão (`esc` fecha) |
| Abrir isolado | botão **Abrir**, em nova aba |
| Ver publicado | botão **claude.ai** |
| Salvar cópia | botão **Salvar cópia** → `~/artefatos-salvos/<projeto>/` |

A lista se atualiza sozinha a cada 8 segundos.

---

## De onde vêm os artefatos

Duas fontes, combinadas e deduplicadas por caminho de arquivo:

**1. Transcripts (fonte autoritativa).** Toda chamada da ferramenta `Artifact`
fica registrada nos `.jsonl` de `~/.claude/projects/` e de cada perfil em
`~/.claude-profiles/*/projects/`. De lá saem título, descrição, favicon, a URL
publicada no `claude.ai` e o **timestamp real da criação**. São os cartões
marcados como `☁ publicado`.

**2. Scratchpads.** HTMLs em `/tmp/claude-<uid>/<projeto>/<sessão>/scratchpad/`
que nunca passaram pela ferramenta `Artifact`. Aparecem como `local`, datados
pelo `birthtime` do arquivo. Vão até 3 níveis de subpasta e descartam ruído
(`_*.html`, `*.src.html`, `node_modules/`, `dist/`, `assets/`, arquivos < 512 B).

O agrupamento usa o **slug do diretório do transcript** como chave, não o `cwd`
da mensagem: quando o agente faz `cd` para o scratchpad, o `cwd` deixa de
identificar o projeto. O nome exibido é o `cwd` que volta a produzir aquele slug
— e fica persistido no banco, para continuar certo depois que os transcripts
saírem do ar.

---

## O banco

`~/.local/share/artefatos/artefatos.db` — metadados, conteúdo e o cache de
varredura. Cada cartão tem um de três estados:

| Estado | O que significa |
|---|---|
| **no disco** | o arquivo está lá; é servido direto |
| **🗄 arquivado** | o arquivo sumiu do `/tmp`, o conteúdo vem do banco |
| **perdido** | sem arquivo e sem cópia; resta o link do `claude.ai` |

O conteúdo é guardado com gzip e deduplicado por `sha256`: republicar sem editar
não cria linha nova, e editar cria uma versão a mais. Hoje são 92 artefatos,
7,7 MB de HTML em 2,4 MB comprimidos.

Arquivos acima de 8 MB (`ARTEFATOS_MAX_ARCHIVE_BYTES`) não são arquivados —
aparecem normalmente enquanto estiverem no disco.

**O arquivador não depende do navegador.** Um timer no servidor reescaneia e
arquiva a cada `ARTEFATOS_ARCHIVE_INTERVAL` (5 min). Sem isso, um artefato
criado e perdido entre duas visitas à interface nunca seria salvo.

**O banco só preserva o que viu enquanto rodava.** Artefatos criados antes da
primeira varredura e já apagados do `/tmp` não são recuperáveis — os 93 de hoje
são a linha de base.

Para reduzir: `artefatos prune --days 30` descarta snapshots antigos e sempre
preserva o mais recente de cada artefato.

---

## Isto roda em outra máquina?

Roda, mas nem todo caminho é padrão do Claude Code. O que muda por instalação:

| Caminho | É padrão? |
|---|---|
| `~/.claude/projects/` | **Sim** — instalação limpa do Claude Code |
| `$CLAUDE_CONFIG_DIR/projects/` | **Sim** — variável oficial para mover a config |
| `~/.claude-profiles/<perfil>/projects/` | **Não** — convenção do projeto [claude-profiles](https://github.com/nandinhos/claude-profiles), que isola harnesses via `CLAUDE_CONFIG_DIR` |
| `<tmpdir>/claude-<uid>/…/scratchpad/` | **Observado, não documentado** |

As três primeiras são varridas automaticamente e deduplicadas; use
`ARTEFATOS_CONFIG_DIRS=dir1,dir2` para acrescentar outras. Quando nada é
encontrado, o CLI **lista onde procurou** em vez de dizer só "nenhum projeto".

Sobre o scratchpad: nesta máquina, todas as 17.696 referências nos transcripts
usam `/tmp/claude-1000` — evidência forte do padrão `<tmpdir>/claude-<uid>`, não
prova de contrato. Em macOS o uid costuma ser 501, e `TMPDIR` pode apontar para
outro lugar; não testei em outra instalação. O caminho é derivado de
`os.tmpdir()` + uid real, e `ARTEFATOS_SCRATCH_ROOT` sobrescreve.

### O banco viaja; a varredura não

`artifacts.path` é absoluto e específico da máquina — mas `project_slug`,
`project_path` e `project_name` estão persistidos e os snapshots guardam o
conteúdo. Copiar o `.db` para outra máquina entrega **um arquivo navegável
completo**, mesmo sem nenhum transcript ou scratchpad:

```bash
scp ~/.local/share/artefatos/artefatos.db outra-maquina:~/
ARTEFATOS_DB=~/artefatos.db node bin/artefatos.js list
```

Verificado com `HOME` vazio e sem scratchpad: os 93 artefatos e 9 projetos
continuam listados com nome e caminho corretos, 92 deles servidos do gzip.
Tudo entra como `arquivado`, porque de fato nenhum arquivo está no disco de lá.

---

## Datas

Publicados usam o timestamp do transcript (o momento exato da publicação).
Locais usam o `birthtime` do arquivo; onde o sistema de arquivos não expõe
`birthtime`, o cartão mostra `data = modificação` em vez de fingir que é criação.

---

## Desempenho

A varredura completa lê ~870 MB de transcript em ~4 s. Depois disso, um cache
por arquivo (chaveado por tamanho + mtime, guardado no próprio SQLite) derruba o
rescan para **~80 ms**, então "monitorar" é reescanear sob demanda — sem daemon,
sem `fs.watch`. Um `ETag` evita redesenhar a tela quando nada mudou. `scan`
ignora o cache e relê tudo.

---

## Configuração

| Variável | Padrão |
|---|---|
| `ARTEFATOS_PORT` | `7788` |
| `ARTEFATOS_HOST` | `127.0.0.1` (o container usa `0.0.0.0`) |
| `ARTEFATOS_DB` | `~/.local/share/artefatos/artefatos.db` |
| `ARTEFATOS_SAVE_DIR` | `~/artefatos-salvos` |
| `ARTEFATOS_SCRATCH_ROOT` | `<tmpdir>/claude-<uid>` |
| `ARTEFATOS_CONFIG_DIRS` | — (raízes extras de transcript, separadas por vírgula) |
| `ARTEFATOS_ARCHIVE_INTERVAL` | `300000` (5 min) |
| `ARTEFATOS_MAX_ARCHIVE_BYTES` | `8388608` (8 MB) |
| `ARTEFATOS_TTL` | `4000` (ms de reaproveitamento do índice) |
| `ARTEFATOS_MAX_DEPTH` | `3` (profundidade no scratchpad) |

---

## Sobre as montagens do container

Os caminhos dentro do container são **idênticos aos do host**. Não é estética:
os transcripts guardam caminhos absolutos (`/tmp/claude-1000/...`), e é por eles
que o scanner encontra cada arquivo — montar em outro lugar faria todo artefato
parecer removido.

Só as pastas `projects/` de cada perfil são montadas, nunca
`~/.claude-profiles` inteiro, que guarda `.credentials.json`. Tudo que é fonte
entra como `:ro`; só o banco e as cópias salvas são graváveis. A porta é
publicada em `127.0.0.1` — o processo ouve em `0.0.0.0` dentro do container,
mas nada é exposto na rede.

Se algum artefato aparecer como `arquivado` sem motivo, é um caminho fora das
montagens (foi o caso de `~/.claude/jobs/`, hoje incluído). O banco continua
servindo o conteúdo mesmo assim; montar a pasta só o traz de volta ao vivo.

---

## Estrutura

```
bin/setup.sh       detecta o ambiente → .env, override e /artefatos
bin/artefatos.js   CLI: serve | aqui | list | scan | stats | prune
commands/          template do slash command (instalado pelo setup)
src/config.js      raízes, filtros de ruído, variáveis de ambiente
src/scanner.js     varredura dos transcripts + scratchpads → índice
src/store.js       SQLite: metadados, snapshots gzip, cache de varredura
src/server.js      HTTP: /api/index, /view/<id>, /api/save, /api/health
public/            interface (index.html, app.js, style.css)
Dockerfile         imagem node:22-alpine, sem build step
compose.yaml       montagens espelhadas do host, restart automático
```

O preview roda o HTML sem `sandbox`, de propósito: é conteúdo local do próprio
usuário e precisa de scripts e `localStorage` para renderizar como foi
publicado. O cliente nunca envia caminho de arquivo — pede um `id` que o
servidor resolve pelo índice, então não há como pedir um arquivo fora dele.
